import asyncio
import struct
from pathlib import Path

import pytest
from typer.testing import CliRunner

from fakegatt import FakeConnector, FakeGattClient, FakeService, ftms_services, ks_services
from test_kingsmith import status_frame
from walkpad_bridge import ble
from walkpad_bridge.backend import BackendError
from walkpad_bridge.cli import app
from walkpad_bridge.kingsmith import STATUS_QUERY

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


@pytest.mark.parametrize("command", [["speed", "3"], ["stop"]])
def test_real_device_control_is_refused(command: list[str]) -> None:
    result = runner.invoke(app, command)
    assert result.exit_code == 2
    assert "not implemented" in result.output


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
