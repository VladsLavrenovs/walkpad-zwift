# walkpad-bridge

Python 3.12 service that talks to the WalkingPad over BLE and exposes live data and stats
(HTTP + WebSocket, UDP for the Windows receiver). Managed with [uv](https://docs.astral.sh/uv/).

Status: core done (backend interface, FAKE pad, safety controller, CLI). No real BLE backend,
HTTP API or storage yet.

## Develop

```sh
cd bridge
uv sync          # create .venv and install deps
uv run pytest    # run tests (no hardware needed)
```

## CLI

Only `--fake` works until the BLE backend lands.

```sh
uv run walkpad-bridge live --fake              # print live samples (read-only)
uv run walkpad-bridge speed 4.5 --fake         # start if needed, ramp to 4.5 km/h; Ctrl+C stops the belt
uv run walkpad-bridge speed 4.5 --fake --hold 60   # ...walk 60 s after reaching it, then stop
uv run walkpad-bridge stop --fake              # stop and wait until the belt is stopped
```

`--fake-speed` sets the speed the simulated pad is already walking at. `-v` shows INFO logs.
`speed` stops the belt when it exits: the CLI is the controlling client, and a controlling client
going away always stops the belt. SIGINT (Ctrl+C), SIGTERM and SIGHUP all stop the belt, print
samples until the pad reports it stopped, and exit 0. A repeated signal cannot interrupt the stop.
On Windows (dev only) the signals are Ctrl+C and Ctrl+Break; SIGTERM there is an uncatchable kill.

## Design

| Module | Role |
|---|---|
| `backend.py` | `PadBackend` interface: `connect`, `disconnect`, `samples()`, `set_speed`, `start`, `stop`, connection-lost listeners. `Sample` = speed km/h, distance m, steps, elapsed s, belt state. |
| `fake.py` | `FakeBackend`: simulated pad. The belt accelerates at 1 km/h/s, distance integrates speed, and step cadence follows speed. `simulate_connection_loss()` and `fail_connects` are there for tests. |
| `safety.py` | `SpeedController`: the **only** code allowed to call `backend.set_speed` (a test enforces this). |
| `clock.py` | Injectable clock, so tests run ramps on virtual time. |
| `config.py` | Loads `config.toml` (or `$WALKPAD_CONFIG`). Unknown keys are an error. |
| `cli.py` | Typer CLI. |

### Safety rules (SpeedController)

- **Cap**: targets are clamped to `min(max_speed_kmh, device max)` and raised to the device min.
  NaN, negative and infinite values are rejected. 0 means stop.
- **Ramp**: at most `max_ramp_kmh_per_s * ramp_tick_s` per tick, one command per tick.
  Retargeting mid-ramp continues from the last commanded speed.
- **Pad connection lost**: cancel the ramp, refuse commands, reconnect (with retries) and send
  stop. If every retry fails, log CRITICAL.
- **Controlling client disconnects**: stop the belt. The controlling client is the last one that
  started the belt or changed its speed.
- `stop()` is always immediate; the pad decelerates on its own.
- **Belt above cap** (e.g. someone used the pad's own remote): it is not forced down. Feed every
  sample to `controller.observe()`, and it logs a warning and emits a `SafetyEvent`
  (`BELT_ABOVE_CAP`, then `BELT_WITHIN_CAP` once it is back under the cap) to listeners
  registered with `add_event_listener()`, so the UI can show it. The next `set_speed` ramps down
  gradually.

## TODO (HTTP API milestone)

- Enforce control from localhost/LAN only, with remote access read-only (CLAUDE.md).
- Speed responses must include the **actually applied target** (the value `set_speed()` returns
  after clamping), not just echo the request.
- Push `SafetyEvent`s to clients over the WebSocket.

## Config

- Non-secret settings: [config.toml](config.toml) (safety limits).
- Secrets: `bridge/.env` (git-ignored). See `.env.example`.
