# WalkPad — project brief

Personal, single-user, Zwift-inspired app for a KingSmith WalkingPad.
Owner: Vlads. Not a commercial product. Keep it simple, well-tested, and safe.

## What it does

- Reads live data from the walking pad over Bluetooth Low Energy (speed, distance, steps, time).
- Controls the belt (start / stop / set speed) with strict safety limits.
- Stores every session and shows statistics and history.
- Renders a smooth "walk across the world" view: a 4-frame PNG walker sprite (back view) fixed on screen,
  the world (Google Photorealistic 3D Tiles via CesiumJS) moving around it along a real route.
- Worlds are pluggable: placeholder, YouTube walking videos synced to belt speed, Google 3D tiles,
  and a procedurally generated fantasy world. HUD, stats and controls are shared by all worlds.
- Later: optional Windows receiver that turns walking into virtual Xbox controller input for other games.

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

Production access goes through Cloudflare: the web app is deployed from GitHub, the bridge is exposed
via a Cloudflare Tunnel (`walkpad-bridge.connectedovals.com`), and both hostnames sit behind
Cloudflare Access allowing only the owner's email.

## Repo layout

```
/bridge     Python 3.12, managed with uv. bleak, FastAPI (HTTP + WebSocket), SQLite, pytest
/web        Vite + TypeScript. CesiumJS. No heavy UI framework unless clearly needed
/receiver   Windows game receiver (later)
/docs       setup guides (Cloudflare, systemd, Google/ORS keys)
```

## Rules

### Safety (non-negotiable)
- Speed changes always go through one function that enforces: max speed cap (config, default 6 km/h),
  max ramp rate (config, default 0.5 km/h per second), and valid range for the device.
- If the BLE connection or the controlling client disconnects while the belt is running, stop the belt.
- Belt control commands are accepted only from localhost/LAN by default. Remote control over the
  tunnel must be explicitly enabled in config and is off by default. Remote access is read-only.
- Never send a speed command from a code path that runs during tests with real hardware unless the
  user explicitly started a manual hardware test.

### Testing
- Everything must run without the pad: the FAKE backend simulates realistic walking data.
- Every bridge feature gets pytest coverage against the FAKE backend.
- The web app must work in FAKE mode and with a flat placeholder world (no Google tiles).
- When a step needs real hardware or a real account (pad, Google, Cloudflare), stop and give me a
  short manual test checklist instead of guessing that it works.

### Cost protection
- Google 3D tiles load only when the "real world" mode is switched on. Default in dev is the flat
  placeholder world, to avoid burning root tile requests on hot reloads.
- Never commit keys. All secrets in `.env` files that are git-ignored; keep `.env.example` updated.

### Style
- Small, focused commits with clear messages. One milestone per prompt.
- Prefer boring, well-known libraries. Explain any new dependency in one line.
- Config in one place per component (`bridge/config.toml`, `web/.env`).
- Update the README section of the component you touched.

## Hardware
- The owner's pad speaks KingSmith's proprietary BLE protocol only (service 0xFE00, no FTMS),
  firmware `M30_V187.2.0`; live data and belt control verified on 2026-09-30 (see
  `bridge/README.md`). The exact model name is still unconfirmed. The bridge auto-detects
  KingSmith vs FTMS (0x1826) anyway.
- Start: the pad counts down (belt states 9, 8, 7) and then runs up to its own start speed
  (2.5 km/h) unless the bridge pins the speed right after it starts moving.
- The belt keeps running when the BLE link drops. The bridge owes a stop until it reaches the pad.
- The pad stops the belt by itself about 35 s after nobody is on it, and its time/steps counters
  only count while someone walks.
- After a long idle, start needs the switch to manual mode first (the bridge always sends it).
