# walkpad-bridge

Python 3.12 service that talks to the WalkingPad over BLE and exposes live data and stats
(HTTP + WebSocket, UDP for the Windows receiver). Managed with [uv](https://docs.astral.sh/uv/).

Status: core done (backend interface, FAKE pad, safety controller, CLI). Real pad over BLE:
scan, inspect and live data are verified on the owner's pad; belt control (start/stop/speed,
always through SpeedController) is implemented and gated behind `--manual-test` until it has
been tested on the pad. No HTTP API or storage yet.

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

### Belt control on the real pad

```sh
uv run walkpad-bridge speed 1.0 --manual-test --max-speed 1.5   # address from config.toml
uv run walkpad-bridge stop                                        # always allowed, never asks
```

- `speed` on the real pad requires `--manual-test` for now. It connects, shows the belt state
  and the plan (target, cap, ramp), and sends nothing until you type `yes`. It refuses to start
  if the belt is not stopped. Everything (commands, raw frames, samples, lag) is logged to
  `bridge/logs/manual-test-*.log` (git-ignored).
- `--max-speed` lowers the cap for one run; it can never exceed `max_speed_kmh` in config.toml.
- After `start` it waits until the pad reports the belt moving (after a 9-8-7 countdown), then
  immediately pins it one ramp step from its actual speed towards the target, then ramps on. Without the pin the owner's
  pad runs up to its own start speed (2.5 km/h), past a 1.5 km/h cap (seen 2026-09-30).
- On exit (Ctrl+C, SIGTERM, error) it sends stop and, if the pad still reports the belt running
  3 s later, sends it again. It prints "Belt stopped." only when the pad has reported it.
- If the BLE link drops, it reconnects and sends stop (SpeedController); if that fails it says
  so loudly. **The belt keeps running when the link drops**, as seen with the KS Fit app.
- `--manual-test` also prints the **belt response lag**: time from each command to the pad's
  status showing its effect (start: belt moving; speed: reached; stop: stopped). Resolution is
  one status report (`kingsmith_poll_s`; set 0.5 for finer numbers).

Guards in `BleBackend` on top of SpeedController: start only when the pad reported a stopped
belt (ph4-walkingpad: start can act as a toggle), speed only while it reports running and within
the device range, stop always. KingSmith writes (status queries included) keep >= 0.5 s apart;
start first switches the pad to manual mode and waits 1.5 s, as ph4-walkingpad does. FTMS
control (request control, start, stop, target speed via the Control Point) follows the spec but
is only tested against a fake client. `live` still never writes anything but status queries.

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
| `blebackend.py` | `BleBackend`: the real pad. Owns the connection, picks a protocol handler on connect (sticks with it across reconnects), fans samples out, reports link loss. Guards belt commands (see above). |
| `kingsmith.py` | KingSmith frames, status parser, `KingsmithProtocol` (notify + status polling). |
| `ftms.py` | FTMS Treadmill Data / Supported Speed Range parsers, `FtmsSession` (merges split packets, integrates when the pad sends speed only), `FtmsProtocol`. |
| `lag.py` | `LagMeter`: command-to-effect lag from SpeedController command events and samples. |
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
- **No command above the cap, ever.** A ramp that starts from a belt above the cap commands the
  cap first (a bigger step down than the ramp rate, on purpose), then ramps normally.
- **Belt above cap**: feed every sample to `controller.observe()`. It logs a warning and emits a
  `SafetyEvent` (`BELT_ABOVE_CAP`, then `BELT_WITHIN_CAP` once back under the cap) to listeners
  registered with `add_event_listener()`, so the UI can show it.
  - Nobody in control (e.g. started with the pad's own remote): that is all; not forced down.
  - The bridge in control (a client started it or set its speed): the controller **holds** the
    belt. Right after `start` the first ramp step is sent at once, one step from the actual speed. If the pad
    reports more than the commanded speed for 2 samples, it ramps back down (so the remote
    cannot push a bridge-controlled belt up). If the belt stays above the cap for
    `above_cap_stop_s` (5 s), it stops the belt and emits `FAILSAFE_STOP`.

Tests use `tests/fakegatt.py`, a stand-in for bleak's `BleakClient` (including `SimulatedKsPad`,
which answers status queries and obeys commands), so all BLE code runs without Bluetooth. An
autouse fixture makes real Bluetooth unreachable from tests, even though config.toml names the
real pad.

## TODO (HTTP API milestone)

- Enforce control from localhost/LAN only, with remote access read-only (CLAUDE.md).
- Speed responses must include the **actually applied target** (the value `set_speed()` returns
  after clamping), not just echo the request.
- Push `SafetyEvent`s to clients over the WebSocket.
- `SpeedController` should subscribe to the backend's sample stream itself instead of relying
  on callers to call `observe()` (today a caller that forgets means above-cap goes unreported).

## TODO (web milestone)

- Show the pad's start countdown in the UI. The pad reports it as KingSmith belt states
  9 -> 8 -> 7 (about 1 s each) before 1 (running); today `KsStatus.belt` folds them into
  RUNNING, so the bridge must expose them first (e.g. a `starting` belt state or a countdown
  field in `Sample`, sent over the WebSocket).

## Config

- Non-secret settings: [config.toml](config.toml) (`[safety]` limits, `[ble]` address, protocol, timeouts).
- Secrets: `bridge/.env` (git-ignored). See `.env.example`.

## Belt control: what was verified on the owner's pad (2026-09-30)

- Verified (parts A-D below): start (manual mode, 9-8-7 countdown, 4.6 s to moving), pin after
  start, ramp, cap clamp with `--max-speed 1.5`, Ctrl+C stop (2.6 s from 1.0-1.5 km/h), stop
  confirmation, lag logging. The belt never exceeded the cap after the pin fix. Without a
  walker the pad's time/steps counters freeze at 3 s; with one they count normally.
- Seen: during the pad's own run-up to its start speed (2.5 km/h) the belt can overshoot the
  pin by about 0.3-0.5 km/h for 1-2 s before obeying. A cap below ~1.5 km/h may be exceeded
  that briefly (then corrected; failsafe stop after 5 s).
- **Not verified on the pad** (part E): stopping with the remote during a bridge session, and
  BLE link loss while walking (reconnect + stop). Both are covered by tests against simulated
  pads only.

## Manual test plan: belt control

Do this in order and stop at the first surprise. Keep every run slow (`--max-speed 1.5`).

**Before you start**
1. Remote in hand (or, if it cannot be found, stand where you can reach the power switch). You
   know how to stop the belt without the laptop: remote stop, power switch, or step off onto
   the side rails.
2. KS Fit closed / phone Bluetooth off. Belt stopped. Nobody else near the pad.
3. Optional, for finer lag numbers: `kingsmith_poll_s = 0.5` in config.toml.

**A. Stop only** (nothing can start the belt)
4. `uv run walkpad-bridge stop`: prints the belt state, then "Belt stopped.", exit 0.

**B. Abort path**
5. `uv run walkpad-bridge speed 1.0 --manual-test --max-speed 1.5`, answer `no`: prints
   "Aborted. Nothing was sent to the pad." The belt must not move.

**C. First start, standing beside the pad (not on it)**
6. Same command, answer `yes`. Expect: countdown on the pad, then "Belt moving at ~1.0 km/h"
   and a `KS tx speed 1.0` line right after it (the pin).
7. Expect "Reached 1.0 km/h." and the belt **stays** at 1.0, never 2.5. If it goes above 1.5,
   expect a "correcting" warning and a return to 1.0 within a few seconds, or a failsafe stop
   after 5 s. If it does not come back down, press Ctrl+C / use the remote and send me the log.
   Walk alongside; let it run 20 s.
8. Ctrl+C: expect "stopping the belt", the belt stops, then "Belt stopped." and the lag summary.

**D. Walking on it**
9. Step on, then run `speed 1.0 --manual-test --max-speed 1.5` again and walk. Stop with Ctrl+C.
10. `speed 1.5 --manual-test --max-speed 1.5`: the ramp goes up in steps of at most 0.5 km/h per
    second. Stop with Ctrl+C.
11. Cap check: `speed 3 --manual-test --max-speed 1.5` must say "clamped to 1.5 km/h".

**E. Stops that do not come from the bridge**
12. While walking under `speed 1.0 --manual-test`, stop the belt with the **remote**. Expect
    "The pad reports the belt stopped ... Ending the session." and no restart. (During a ramp
    it exits with "Error: belt is not running" instead; also fine.)
13. While walking, kill the link: in another terminal `bluetoothctl power off`, wait 3 s,
    `bluetoothctl power on`. The belt may keep running: be ready with the remote. Expect
    "Connection to the pad lost", then a reconnect and stop within about 10-30 s. If it cannot
    reconnect, it prints a CRITICAL "STOP THE PAD MANUALLY": do so.

**Send me**: the terminal output of C and E, the `bridge/logs/manual-test-*.log` files, the start
speed you saw in step 6, and anything that surprised you.
