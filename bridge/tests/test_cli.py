from typer.testing import CliRunner

from walkpad_bridge.cli import app

runner = CliRunner()
FAST = ["--time-scale", "1000"]


def test_live_prints_samples() -> None:
    result = runner.invoke(app, ["live", "--fake", "--count", "3", *FAST])
    assert result.exit_code == 0, result.output
    lines = [line for line in result.output.splitlines() if "km/h" in line]
    assert len(lines) == 3
    assert "running" in lines[0]


def test_real_backend_not_available_yet() -> None:
    result = runner.invoke(app, ["live"])
    assert result.exit_code == 2
    assert "--fake" in result.output


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
