# WalkPad

Personal, Zwift-inspired app for a KingSmith WalkingPad: live treadmill data over BLE, safe belt
control, session history and stats, and a "walk across the world" view in CesiumJS.

Status: bridge core (FAKE pad, safety controller, CLI) done; no real BLE, API or UI yet. See [CLAUDE.md](CLAUDE.md) for the full brief and rules.

## Architecture

```
[KingSmith pad] --BLE--> [bridge: Python service on Ubuntu laptop]
                              |-- SQLite (sessions, samples, routes)
                              |-- WebSocket (live data)  + HTTP API (stats, routes)
                              |-- UDP (live data, LAN, for the Windows game receiver)
                              v
        [web app: Vite + TypeScript + CesiumJS]  -> deployed to walk.connectedovals.com
        [receiver: Windows, virtual gamepad]     -> later, optional
```

Production access goes through Cloudflare: the web app deploys from GitHub, the bridge is exposed
via a Cloudflare Tunnel (`walkpad-bridge.connectedovals.com`), and both hostnames sit behind
Cloudflare Access allowing only the owner.

## Repo layout

| Path        | What                                                                 |
|-------------|----------------------------------------------------------------------|
| `bridge/`   | Python 3.12 (uv): BLE, FastAPI HTTP + WebSocket, SQLite, pytest. [README](bridge/README.md) |
| `web/`      | Vite + TypeScript, CesiumJS. [README](web/README.md)                 |
| `receiver/` | Windows game receiver (later)                                        |
| `docs/`     | Setup guides (Cloudflare, systemd, Google/ORS keys). [index](docs/README.md) |

## Quick start

```sh
cd bridge && uv sync && uv run pytest
cd web && npm install && npm run dev
```

Secrets go in `bridge/.env` and `web/.env` (git-ignored); copy from the `.env.example` next to each.

## CI

[.github/workflows/ci.yml](.github/workflows/ci.yml) runs on every push and PR:
bridge `pytest`, web `typecheck` + `build`.
