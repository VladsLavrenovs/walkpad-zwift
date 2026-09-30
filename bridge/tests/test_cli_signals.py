"""Run `speed 4 --fake` as a real process and signal it: the belt must stop, exit must be clean.

SIGINT/SIGTERM/SIGHUP run on POSIX (CI and the Ubuntu bridge host). Windows has no SIGHUP and
cannot catch SIGTERM, so there we exercise the same shutdown path with Ctrl+Break.
"""

from __future__ import annotations

import os
import queue
import signal
import subprocess
import sys
import threading
import time
from collections.abc import Callable

import pytest

WINDOWS = sys.platform == "win32"
posix_only = pytest.mark.skipif(WINDOWS, reason="POSIX signal")
windows_only = pytest.mark.skipif(not WINDOWS, reason="Windows console control event")

READY_LINE = "Walking. Press Ctrl+C to stop the belt."
TIMEOUT_S = 20


class SpeedProcess:
    def __init__(self, time_scale: float = 50) -> None:
        env = {**os.environ, "PYTHONUNBUFFERED": "1"}
        kwargs = {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if WINDOWS else {}
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "walkpad_bridge", "speed", "4", "--fake", "--time-scale", str(time_scale)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
            **kwargs,  # type: ignore[arg-type]
        )
        self.lines: queue.Queue[str] = queue.Queue()
        self.stdout: list[str] = []
        self._reader = threading.Thread(target=self._read, daemon=True)
        self._reader.start()

    def _read(self) -> None:
        assert self.proc.stdout is not None
        for line in self.proc.stdout:
            self.lines.put(line.rstrip("\n"))

    def wait_for(self, match: str | Callable[[str], bool]) -> None:
        matches = match if callable(match) else match.__eq__
        deadline = time.monotonic() + TIMEOUT_S
        while time.monotonic() < deadline:
            try:
                line = self.lines.get(timeout=0.1)
            except queue.Empty:
                if self.proc.poll() is not None:
                    break
                continue
            self.stdout.append(line)
            if matches(line):
                return
        self.proc.kill()
        pytest.fail(f"never saw {match!r}; output so far: {self.stdout}")

    def finish(self) -> tuple[int, list[str], str]:
        try:
            code = self.proc.wait(timeout=TIMEOUT_S)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            pytest.fail(f"did not exit after signal; output: {self.stdout}")
        self._reader.join(timeout=5)
        while not self.lines.empty():
            self.stdout.append(self.lines.get())
        assert self.proc.stderr is not None
        return code, self.stdout, self.proc.stderr.read()


def assert_stopped_cleanly(code: int, out: list[str], err: str, signame: str) -> None:
    assert code == 0, (out, err)
    assert "Traceback" not in err, err
    assert f"Received {signame}; stopping the belt." in out
    assert out[-1] == "Belt stopped."
    assert out[-2].endswith("| stopped"), out  # the pad itself reported the belt stopped


@pytest.mark.parametrize(
    "sig",
    [
        pytest.param("SIGINT", marks=posix_only),
        pytest.param("SIGTERM", marks=posix_only),
        pytest.param("SIGHUP", marks=posix_only),
    ],
)
def test_posix_signal_stops_belt(sig: str) -> None:
    p = SpeedProcess()
    p.wait_for(READY_LINE)
    p.proc.send_signal(getattr(signal, sig))
    assert_stopped_cleanly(*p.finish(), signame=sig)


@posix_only
def test_signal_during_ramp_stops_belt() -> None:
    p = SpeedProcess(time_scale=1)  # real time: the 0.5 -> 4 km/h ramp takes ~7 s
    p.wait_for(lambda line: line.endswith("| running") and not line.startswith(" 0.0"))
    p.proc.send_signal(signal.SIGTERM)
    code, out, err = p.finish()
    assert_stopped_cleanly(code, out, err, "SIGTERM")
    assert "Reached 4.0 km/h." not in out


@posix_only
def test_repeated_signal_does_not_interrupt_the_stop() -> None:
    p = SpeedProcess(time_scale=5)  # stopping takes ~0.8 s, so all signals land mid-stop
    p.wait_for(READY_LINE)
    for _ in range(3):
        p.proc.send_signal(signal.SIGINT)
    code, out, err = p.finish()
    assert_stopped_cleanly(code, out, err, "SIGINT")
    assert out.count("Received SIGINT; stopping the belt.") == 1


@windows_only
def test_ctrl_break_stops_belt() -> None:
    p = SpeedProcess()
    p.wait_for(READY_LINE)
    os.kill(p.proc.pid, signal.CTRL_BREAK_EVENT)  # type: ignore[attr-defined]
    assert_stopped_cleanly(*p.finish(), signame="SIGBREAK")
