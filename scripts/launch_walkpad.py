#!/usr/bin/env python3
"""WalkPad launcher: make sure the bridge is running, then open the web UI.

No terminal needed when started from the walkpad.desktop shortcut.
Standard library only.
"""

import shutil
import subprocess
import sys
import time
import urllib.request

URL = "http://localhost:8080"
SERVICE = "walkpad-bridge"   # check with: systemctl --user list-units 'walkpad*'
FULLSCREEN = False           # True = Firefox kiosk mode (close with Alt+F4)
WAIT_SECONDS = 20


def notify(message: str) -> None:
    """Show a desktop notification (falls back to stderr)."""
    if shutil.which("notify-send"):
        subprocess.run(["notify-send", "WalkPad", message], check=False)
    else:
        print(f"WalkPad: {message}", file=sys.stderr)


def bridge_responds() -> bool:
    try:
        with urllib.request.urlopen(URL, timeout=2) as response:
            return response.status < 500
    except OSError:
        return False


def ensure_bridge() -> bool:
    if bridge_responds():
        return True
    subprocess.run(["systemctl", "--user", "start", SERVICE], check=False)
    deadline = time.monotonic() + WAIT_SECONDS
    while time.monotonic() < deadline:
        if bridge_responds():
            return True
        time.sleep(0.5)
    return False


def open_ui() -> None:
    # Chrome/Chromium: own window without tabs or address bar.
    for browser in ("google-chrome", "chromium", "chromium-browser"):
        if shutil.which(browser):
            subprocess.Popen([browser, f"--app={URL}"])
            return
    if shutil.which("firefox"):
        args = ["firefox", "--kiosk", URL] if FULLSCREEN else ["firefox", "--new-window", URL]
        subprocess.Popen(args)
        return
    import webbrowser
    webbrowser.open(URL)


def main() -> int:
    if not ensure_bridge():
        notify(f"Bridge didn't start. Check: systemctl --user status {SERVICE}")
        return 1
    open_ui()
    return 0


if __name__ == "__main__":
    sys.exit(main())
