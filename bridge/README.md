# walkpad-bridge

Python 3.12 service that talks to the WalkingPad over BLE and exposes live data and stats
(HTTP + WebSocket, UDP for the Windows receiver). Managed with [uv](https://docs.astral.sh/uv/).

Status: core done (backend interface, FAKE pad, safety controller, CLI). Real pad over BLE is
**read-only** (scan, inspect, live data); real-device belt control, HTTP API and storage are not
built yet.

## Develop

```sh
cd bridge
uv sync          # create .venv and install deps
uv run pytest    # run tests (no hardware needed)
```

## Real pad (Ubuntu, BlueZ)

Before you start:

- **Close the KS Fit app on your phone** (force-quit it, or turn phone Bluetooth off). The pad
  accepts one BLE connection at a time.
- **Do not pair the pad in `bluetoothctl`** or GNOME Bluetooth settings. The bridge connects
  without pairing. If you already paired it: `bluetoothctl remove <address>`.

```sh
uv run walkpad-bridge scan                      # nearby BLE devices; likely pads marked * and listed first
uv run walkpad-bridge inspect AA:BB:CC:DD:EE:FF # dump GATT services/characteristics, report the protocol
uv run walkpad-bridge live AA:BB:CC:DD:EE:FF    # live data, read-only; Ctrl+C to quit
uv run walkpad-bridge live AA:BB:CC:DD:EE:FF --protocol kingsmith   # force a protocol
```

Set `[ble] address` in [config.toml](config.toml) to skip typing the address. `-v` shows which
services were found and which protocol was chosen. `--debug` (before the command, like `-v`)
also logs every raw frame: `uv run walkpad-bridge --debug live AA:BB:...`.

Protocols (auto-selected from the services the pad offers, FTMS first if both exist):

| Protocol | Service | How live data works | Steps |
|---|---|---|---|
| KingSmith proprietary | `FE00` (notify `FE01`, write `FE02`) | The pad only answers when asked: the bridge writes the status query `F7 A2 00 00 A2 FD` every `kingsmith_poll_s` and decodes `F8 A2` replies. Frame layout from [ph4-walkingpad](https://github.com/ph4r05/ph4-walkingpad). | yes |
| FTMS | `1826` | Treadmill Data (`2ACD`) notifications. Nothing is written. Distance/time come from the pad when it sends them, otherwise the bridge integrates speed. | no (`--`) |

**Owner's pad (verified 2026-09-30):** advertises as `WalkingPad`, speaks **KingSmith proprietary
only** (no FTMS). BLE module `WLT8266M`, firmware `M30_V187.2.0`. `FE02` is write-without-response
only; `FE01` is notify-only (reads fail, which is expected). Status frames match ph4-walkingpad
including the checksum; time (1 s), distance (10 m steps) and steps all decode correctly and
update live while walking. Other Device Information strings are placeholders.

Real-device `set_speed`/`start`/`stop` raise `ControlNotSupportedError`, and `speed`/`stop` refuse
to run without `--fake`. The KingSmith status query is the only thing the bridge ever writes to a
real pad (a test enforces it).

## CLI (FAKE pad)

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
| `backend.py` | `PadBackend` interface: `connect`, `disconnect`, `samples()`, `set_speed`, `start`, `stop`, connection-lost listeners. `Sample` = speed km/h, distance m, steps (None if the protocol has none), elapsed s, belt state. |
| `fake.py` | `FakeBackend`: simulated pad. The belt accelerates at 1 km/h/s, distance integrates speed, and step cadence follows speed. `simulate_connection_loss()` and `fail_connects` are there for tests. |
| `ble.py` | bleak helpers: UUIDs, `scan`, `connect_client` (finds the device first, never pairs), `inspect` (GATT dump, reads only), protocol detection, `ProtocolHandler` base. |
| `blebackend.py` | `BleBackend`: the real pad. Owns the connection, picks a protocol handler on connect (sticks with it across reconnects), fans samples out, reports link loss. Read-only. |
| `kingsmith.py` | KingSmith frames, status parser, `KingsmithProtocol` (notify + status polling). |
| `ftms.py` | FTMS Treadmill Data / Supported Speed Range parsers, `FtmsSession` (merges split packets, integrates when the pad sends speed only), `FtmsProtocol`. |
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

Tests use `tests/fakegatt.py`, a stand-in for bleak's `BleakClient`, so all BLE code runs without
Bluetooth.

## TODO (HTTP API milestone)

- Enforce control from localhost/LAN only, with remote access read-only (CLAUDE.md).
- Speed responses must include the **actually applied target** (the value `set_speed()` returns
  after clamping), not just echo the request.
- Push `SafetyEvent`s to clients over the WebSocket.
- `SpeedController` should subscribe to the backend's sample stream itself instead of relying
  on callers to call `observe()` (today a caller that forgets means above-cap goes unreported).

## Config

- Non-secret settings: [config.toml](config.toml) (`[safety]` limits, `[ble]` address, protocol, timeouts).
- Secrets: `bridge/.env` (git-ignored). See `.env.example`.
