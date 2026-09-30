# walkpad-bridge

Python 3.12 service that talks to the WalkingPad over BLE and exposes live data and stats
(HTTP + WebSocket, UDP for the Windows receiver). Managed with [uv](https://docs.astral.sh/uv/).

Status: scaffold only, no features yet.

## Develop

```sh
cd bridge
uv sync          # create .venv and install deps
uv run pytest    # run tests (no hardware needed)
uv run walkpad-bridge
```

## Config

- Non-secret settings: `bridge/config.toml` (added with the first feature).
- Secrets: `bridge/.env` (git-ignored). See `.env.example`.
