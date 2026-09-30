import asyncio
import struct
from pathlib import Path

import pytest
from typer.testing import CliRunner

from fakegatt import (
    FakeConnector,
    FakeGattClient,
    FakeService,
    SimulatedKsPad,
    ftms_services,
    ks_services,
)
from walkpad_bridge import cli
from test_kingsmith import status_frame
from walkpad_bridge import ble
from walkpad_bridge.backend import BackendError
from walkpad_bridge.cli import app
from walkpad_bridge.kingsmith import MANUAL_MODE, START_BELT, STATUS_QUERY, speed_frame

runner = CliRunner()
FAST = ["--time-scale", "1000"]


def test_live_prints_samples() -> None:
    result = runner.invoke(app, ["live", "--fake", "--count", "3", *FAST])
    assert result.exit_code == 0, result.output
    lines = [line for line in result.output.splitlines() if "km/h" in line]
    assert len(lines) == 3
    assert "running" in lines[0]


ADDRESS = "AA:BB:CC:DD:EE:FF"


@pytest.fixture
def cfg(tmp_path: Path) -> Path:
    """Config with no default address and the fastest allowed KingSmith polling."""
    path = tmp_path / "config.toml"
    path.write_text("[ble]\nkingsmith_poll_s = 0.5\n")
    return path


def test_live_needs_an_address(cfg: Path) -> None:
    result = runner.invoke(app, ["live", "--config", str(cfg)])
    assert result.exit_code == 2
    assert "scan" in result.output and "--fake" in result.output


def test_real_speed_needs_manual_test() -> None:
    result = runner.invoke(app, ["speed", "3", ADDRESS])
    assert result.exit_code == 2
    assert "--manual-test" in result.output


def test_tests_cannot_reach_real_bluetooth() -> None:
    result = runner.invoke(app, ["stop", ADDRESS])
    assert isinstance(result.exception, AssertionError)
    assert "real Bluetooth" in str(result.exception)


def test_scan_highlights_likely_pads(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_scan(timeout_s: float) -> list[ble.ScanResult]:
        return [
            ble.ScanResult(ADDRESS, "KS-ST-A1P", -60, (), ("name",)),
            ble.ScanResult("11:22:33:44:55:66", None, -80),
        ]

    monkeypatch.setattr(ble, "scan", fake_scan)
    result = runner.invoke(app, ["scan", "--timeout", "1"])
    assert result.exit_code == 0, result.output
    assert f"* {ADDRESS}   -60 dBm  KS-ST-A1P  [name]" in result.output
    assert "  11:22:33:44:55:66   -80 dBm  (no name)" in result.output
    assert f"Next: walkpad-bridge inspect {ADDRESS}" in result.output
    assert "KS Fit" in result.output  # the reminder


def test_scan_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    async def failing_scan(timeout_s: float) -> list[ble.ScanResult]:
        raise BackendError("scan failed: org.bluez.Error.NotReady")

    monkeypatch.setattr(ble, "scan", failing_scan)
    result = runner.invoke(app, ["scan", "--timeout", "1"])
    assert result.exit_code == 1
    assert "NotReady" in result.output


def test_inspect_reports_protocols(monkeypatch: pytest.MonkeyPatch, cfg: Path) -> None:
    connector = FakeConnector(lambda: ks_services() + ftms_services())
    monkeypatch.setattr(ble, "connect_client", connector)
    result = runner.invoke(app, ["inspect", ADDRESS, "--config", str(cfg)])
    assert result.exit_code == 0, result.output
    assert '"KS-ST-A1P"' in result.output
    assert "Protocols: FTMS (0x1826), KingSmith proprietary (0xFE00)" in result.output
    assert "Auto-select would use: ftms" in result.output
    assert "FTMS speed range: 0.5-6 km/h, step 0.1" in result.output
    assert connector.client.writes == []
    assert not connector.client.is_connected


def test_inspect_unknown_device(monkeypatch: pytest.MonkeyPatch, cfg: Path) -> None:
    monkeypatch.setattr(ble, "connect_client", FakeConnector(lambda: [FakeService(ble.uuid16("180f"), [])]))
    result = runner.invoke(app, ["inspect", ADDRESS, "--config", str(cfg)])
    assert result.exit_code == 1
    assert "none recognised" in result.output


def test_inspect_connect_failure(monkeypatch: pytest.MonkeyPatch, cfg: Path) -> None:
    monkeypatch.setattr(ble, "connect_client", FakeConnector(ftms_services, fail=1))
    result = runner.invoke(app, ["inspect", ADDRESS, "--config", str(cfg)])
    assert result.exit_code == 1
    assert "not found" in result.output


class StreamingFtmsClient(FakeGattClient):
    """Starts sending treadmill data as soon as notifications are enabled."""

    async def start_notify(self, spec, callback) -> None:  # type: ignore[no-untyped-def]
        await super().start_notify(spec, callback)
        loop = asyncio.get_running_loop()
        for i in range(5):
            loop.call_later(0.01 * (i + 1), self.send, ble.FTMS_TREADMILL_DATA_CHAR,
                            struct.pack("<HH", 0, 300 + i * 10))


def test_live_ftms(monkeypatch: pytest.MonkeyPatch, cfg: Path) -> None:
    connector = FakeConnector(ftms_services)
    connector.client_class = StreamingFtmsClient
    monkeypatch.setattr(ble, "connect_client", connector)
    result = runner.invoke(app, ["live", ADDRESS, "--count", "3", "--config", str(cfg)])
    assert result.exit_code == 0, result.output
    assert "Connected (ftms). Read-only." in result.output
    lines = [line for line in result.output.splitlines() if "km/h" in line]
    assert len(lines) == 3
    assert lines[0].startswith(" 3.0 km/h") and "    -- steps" in lines[0]
    assert connector.client.writes == []
    assert not connector.client.is_connected


class AnsweringKsClient(FakeGattClient):
    """Answers each status query like a pad does; the link drops after the third answer."""

    async def write_gatt_char(self, spec, data, response=None) -> None:  # type: ignore[no-untyped-def]
        await super().write_gatt_char(spec, data, response)
        answered = len(self.writes)
        loop = asyncio.get_running_loop()
        if answered <= 3:
            loop.call_soon(self.send, ble.KS_NOTIFY_CHAR, status_frame(speed=20 + answered))
        if answered == 3:
            loop.call_soon(self.drop)


def test_live_kingsmith_until_link_lost(monkeypatch: pytest.MonkeyPatch, cfg: Path) -> None:
    connector = FakeConnector(ks_services)
    connector.client_class = AnsweringKsClient
    monkeypatch.setattr(ble, "connect_client", connector)
    result = runner.invoke(app, ["live", ADDRESS, "--protocol", "kingsmith", "--config", str(cfg)])
    assert result.exit_code == 1, result.output
    lines = [line for line in result.output.splitlines() if "km/h" in line]
    assert [line[:4] for line in lines] == [" 2.1", " 2.2", " 2.3"]
    assert "1500 steps" in lines[0]
    assert result.output.rstrip().endswith("Connection to the pad lost.")
    assert {data for _, data, _ in connector.client.writes} == {STATUS_QUERY}


def test_live_rejects_missing_protocol(monkeypatch: pytest.MonkeyPatch, cfg: Path) -> None:
    monkeypatch.setattr(ble, "connect_client", FakeConnector(ks_services))
    result = runner.invoke(app, ["live", ADDRESS, "--protocol", "ftms", "--config", str(cfg)])
    assert result.exit_code == 1
    assert "does not offer the ftms service" in result.output


def test_speed_ramps_holds_and_stops_on_exit() -> None:
    result = runner.invoke(app, ["speed", "4", "--fake", "--hold", "2", *FAST])
    assert result.exit_code == 0, result.output
    assert "Reached 4.0 km/h." in result.output
    assert result.output.rstrip().endswith("Belt stopped.")


def test_speed_is_clamped_to_cap() -> None:
    result = runner.invoke(app, ["speed", "9", "--fake", "--hold", "0", *FAST])
    assert result.exit_code == 0, result.output
    assert "clamped to 6.0 km/h" in result.output


def test_stop_waits_for_belt_to_stop() -> None:
    result = runner.invoke(app, ["stop", "--fake", *FAST])
    assert result.exit_code == 0, result.output
    lines = result.output.splitlines()
    assert "stopped" in lines[-2]
    assert lines[-1] == "Belt stopped."


# --- belt control: --max-speed, manual test mode, real-device path -----------------------------


def test_max_speed_lowers_the_cap() -> None:
    result = runner.invoke(app, ["speed", "5", "--fake", "--max-speed", "2", "--hold", "0", *FAST])
    assert result.exit_code == 0, result.output
    assert "clamped to 2.0 km/h" in result.output


@pytest.mark.parametrize("value", ["7", "0", "-1"])
def test_max_speed_cannot_raise_the_cap(value: str) -> None:
    result = runner.invoke(app, ["speed", "3", "--fake", "--max-speed", value, *FAST])
    assert result.exit_code == 2
    assert "at most the configured cap" in result.output


def manual(tmp_path: Path, *args: str) -> list[str]:
    return ["speed", *args, "--manual-test", "--log-dir", str(tmp_path / "logs")]


def test_manual_test_asks_then_runs_and_logs(tmp_path: Path) -> None:
    result = runner.invoke(
        app, manual(tmp_path, "2", "--fake", "--hold", "0", *FAST), input="yes\n"
    )
    assert result.exit_code == 0, result.output
    out = result.output
    assert out.index("MANUAL HARDWARE TEST") < out.index("Type 'yes' to go") < out.index("Reached 2.0")
    assert "cap 6.0 km/h" in out
    assert "Belt response lag" in out and "start     n=1" in out
    assert out.rstrip().endswith("Belt stopped.")
    (log_file,) = (tmp_path / "logs").glob("manual-test-*.log")
    text = log_file.read_text()
    assert "lag summary: start" in text
    assert "km/h" in text  # samples are in the file too


@pytest.mark.parametrize("answer", ["no\n", "y\n", "\n"])
def test_manual_test_anything_but_yes_aborts(tmp_path: Path, answer: str) -> None:
    result = runner.invoke(app, manual(tmp_path, "2", "--fake", *FAST), input=answer)
    assert result.exit_code == 0, result.output
    assert "Aborted. Nothing was sent to the pad." in result.output
    assert result.output.rstrip().endswith("Disconnected.")
    assert "Belt response lag" not in result.output


def test_manual_test_refuses_a_moving_belt(tmp_path: Path) -> None:
    result = runner.invoke(
        app, manual(tmp_path, "2", "--fake", "--fake-speed", "3", *FAST), input="yes\n"
    )
    assert result.exit_code == 1
    assert "stop it first" in result.output
    assert "Type 'yes'" not in result.output


@pytest.fixture
def control_cfg(tmp_path: Path) -> Path:
    """Fast polling and ramp ticks so the real-device path runs in a few seconds."""
    path = tmp_path / "control.toml"
    path.write_text(
        "[ble]\nkingsmith_poll_s = 0.5\n"
        "[safety]\nmax_ramp_kmh_per_s = 1.0\nramp_tick_s = 0.5\n"
    )
    return path


def ks_frames(connector: FakeConnector) -> list[bytes]:
    return [data for _, data, _ in connector.client.writes if data != STATUS_QUERY]


def test_real_pad_manual_test_end_to_end(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, control_cfg: Path
) -> None:
    connector = FakeConnector(ks_services)
    connector.client_class = SimulatedKsPad
    monkeypatch.setattr(ble, "connect_client", connector)
    result = runner.invoke(
        app,
        manual(tmp_path, "1.5", ADDRESS, "--hold", "0", "--config", str(control_cfg)),
        input="yes\n",
    )
    assert result.exit_code == 0, result.output
    assert "(kingsmith)" in result.output
    assert "Reached 1.5 km/h." in result.output
    # The simulated pad starts at 1.0 km/h: pinned one step up (1.5, the target) at once.
    assert ks_frames(connector) == [MANUAL_MODE, START_BELT, speed_frame(1.5), speed_frame(0)]
    assert "Belt moving at 1.0 km/h." in result.output
    assert "start     n=1  lag" in result.output
    assert result.output.rstrip().endswith("Belt stopped.")
    assert not connector.client.is_connected


def test_real_pad_manual_test_abort_sends_nothing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, control_cfg: Path
) -> None:
    connector = FakeConnector(ks_services)
    connector.client_class = SimulatedKsPad
    monkeypatch.setattr(ble, "connect_client", connector)
    result = runner.invoke(
        app, manual(tmp_path, "1.5", ADDRESS, "--config", str(control_cfg)), input="no\n"
    )
    assert result.exit_code == 0, result.output
    assert ks_frames(connector) == []


def test_real_stop_resends_until_the_pad_stops(
    monkeypatch: pytest.MonkeyPatch, control_cfg: Path
) -> None:
    class RunningPad(SimulatedKsPad):
        def __init__(self, *args: object, **kwargs: object) -> None:
            super().__init__(*args, **kwargs)
            self.state, self.mode, self.speed = 1, 1, 20
            self.ignore_stops = 1  # the first stop gets lost

    connector = FakeConnector(ks_services)
    connector.client_class = RunningPad
    monkeypatch.setattr(ble, "connect_client", connector)
    monkeypatch.setattr(cli, "STOP_RETRY_S", 0.6)
    result = runner.invoke(app, ["stop", ADDRESS, "--config", str(control_cfg)])
    assert result.exit_code == 0, result.output
    assert "sending stop again" in result.output
    assert ks_frames(connector) == [speed_frame(0), speed_frame(0)]
    assert result.output.rstrip().endswith("Belt stopped.")


def test_real_pad_ramp_starts_from_the_pads_start_speed(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, control_cfg: Path
) -> None:
    class FastStartPad(SimulatedKsPad):
        start_kmh = 2.0  # the pad's own start-speed setting

    connector = FakeConnector(ks_services)
    connector.client_class = FastStartPad
    monkeypatch.setattr(ble, "connect_client", connector)
    result = runner.invoke(
        app,
        manual(tmp_path, "3", ADDRESS, "--hold", "0", "--config", str(control_cfg)),
        input="yes\n",
    )
    assert result.exit_code == 0, result.output
    # Pinned one step up from 2.0 (no dip to the device minimum), then 3.0.
    assert ks_frames(connector)[2:] == [speed_frame(2.5), speed_frame(3.0), speed_frame(0)]


async def test_not_connected_never_counts_as_stopped() -> None:
    from walkpad_bridge.fake import FakeBackend

    assert await cli._print_until_stopped(FakeBackend(initial_speed_kmh=3.0)) is False


def test_real_pad_stopped_by_remote_ends_the_session(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, control_cfg: Path
) -> None:
    class RemoteStopPad(SimulatedKsPad):
        async def write_gatt_char(self, spec, data, response=None) -> None:  # type: ignore[no-untyped-def]
            await super().write_gatt_char(spec, data, response)
            if bytes(data) == speed_frame(1.5):  # someone presses stop on the remote right after
                asyncio.get_running_loop().call_later(0.2, self._remote_stop)

        def _remote_stop(self) -> None:
            self.state, self.speed = 0, 0

    connector = FakeConnector(ks_services)
    connector.client_class = RemoteStopPad
    monkeypatch.setattr(ble, "connect_client", connector)
    result = runner.invoke(
        app, manual(tmp_path, "1.5", ADDRESS, "--config", str(control_cfg)), input="yes\n"
    )  # no --hold: without the remote stop this would walk until Ctrl+C
    assert result.exit_code == 0, result.output
    assert "Ending the session." in result.output
    assert START_BELT in ks_frames(connector)
    assert ks_frames(connector).count(START_BELT) == 1  # never restarted
