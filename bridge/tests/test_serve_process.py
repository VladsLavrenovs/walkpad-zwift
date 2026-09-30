"""`walkpad-bridge serve --fake` as a real process: serves HTTP, and SIGTERM (systemd stop)
stops the belt, closes the session and exits cleanly.

uvicorn re-raises the signal after its graceful shutdown, so the exit status is -SIGTERM; systemd
treats that as a clean stop of a unit it asked to stop.
"""

from __future__ import annotations

import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import pytest

from walkpad_bridge.storage import Store

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="POSIX signal")


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_serve_fake_then_sigterm(tmp_path: Path) -> None:
    port = free_port()
    cfg = tmp_path / "config.toml"
    cfg.write_text(f'[server]\nhost = "127.0.0.1"\nport = {port}\n'
                   f'[storage]\ndb_path = "{tmp_path / "w.sqlite"}"\nmin_session_s = 0\n')
    proc = subprocess.Popen(
        [sys.executable, "-m", "walkpad_bridge", "-v", "serve", "--fake", "--fake-speed", "3",
         "--config", str(cfg)],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        env={**os.environ, "PYTHONUNBUFFERED": "1"},
    )
    try:
        deadline = time.monotonic() + 20
        while True:
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/status", timeout=1) as r:
                    status = json.loads(r.read())
                if status["connected"]:
                    break
            except OSError:
                pass
            assert time.monotonic() < deadline, "server did not come up"
            time.sleep(0.1)
        assert status["belt"] == "running"  # the fake pad was already walking
        assert status["session_id"] is not None
        proc.send_signal(signal.SIGTERM)
        out, _ = proc.communicate(timeout=30)
    finally:
        proc.kill()
    assert proc.returncode in (0, -signal.SIGTERM), out
    assert "Traceback" not in out, out
    assert "Application shutdown complete" in out
    (session,) = Store(tmp_path / "w.sqlite").list_sessions()
    assert session["ended_at"] is not None  # closed on shutdown, not left dangling
