"""Secrets for the bridge, never for the web bundle.

Looked up in the environment first (the systemd unit loads ~/.config/walkpad/secrets.env via
EnvironmentFile), then in bridge/.env (git-ignored) for development runs.
"""

from __future__ import annotations

import os
from pathlib import Path

DOTENV = Path(__file__).resolve().parents[2] / ".env"


def _read_dotenv(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    try:
        text = path.read_text()
    except OSError:
        return values
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        values[key.strip().removeprefix("export ").strip()] = value.strip().strip("'\"")
    return values


def get_secret(name: str, dotenv: Path = DOTENV) -> str | None:
    value = os.environ.get(name) or _read_dotenv(dotenv).get(name)
    return value or None
