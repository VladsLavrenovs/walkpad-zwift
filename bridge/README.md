# walkpad-bridge

Python 3.12 service that talks to the WalkingPad over BLE and exposes live data and stats
(HTTP + WebSocket, UDP for the Windows receiver). Managed with [uv](https://docs.astral.sh/uv/).

Status: runs as a service (`serve`): live WebSocket, SQLite sessions and stats, UDP output,
LAN-only belt control, and it serves the built web app. Real pad over BLE: live data and belt
control verified on the owner's pad (see below); the CLI `speed` still needs `--manual-test`.

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

## Service (`serve`)

```sh
uv run walkpad-bridge serve --fake          # simulated pad, http://localhost:8080
uv run walkpad-bridge serve                 # the real pad ([ble] address in config.toml)
uv run walkpad-bridge serve 57:4C:4E:36:10:BB --port 8081
```

Always-on install with systemd: [docs/bridge-service.md](../docs/bridge-service.md). The service
keeps running when the pad is off or the phone app has it, retrying every `reconnect_interval_s`.
Only one BLE connection exists, so stop the service before using the CLI commands above on the
real pad. Stopping the service (Ctrl+C, SIGTERM) stops the belt and closes the open session.

| Endpoint | Who | What |
|---|---|---|
| `GET /` | anyone | the built web app (`web/dist`), or a placeholder page if not built. Checked per request: a new build is live without restarting the bridge |
| `GET /status` | anyone | connection, belt, speed, cap, target, controlling client, session id, `control_allowed` for the caller |
| `GET /sessions?limit&offset` | anyone | sessions, newest first, with totals and `avg_speed_kmh` |
| `GET /sessions/{id}` | anyone | one session with its per-second samples |
| `GET /stats` | anyone | `daily` (7 days), `weekly` (8 weeks, Monday start), `monthly` (12), `streaks`, `personal_bests`, `all_time` |
| `WS /live?client=<id>` | anyone | JSON messages: `status` on connect and on changes, `sample` per pad report, `safety` events |
| `POST /control/start {"kmh": 1.5}` | localhost/LAN | start, then (once moving) ramp to kmh |
| `POST /control/speed {"kmh": 2.0}` | localhost/LAN | ramp to kmh |
| `POST /control/stop` | localhost/LAN | stop now |
| `GET /videos` | anyone | video library for the YouTube world, last played first |
| `POST /videos {"url": "...", "pace_kmh": 4.5}` | localhost/LAN | add a YouTube link (201; 200 if already there; 422 not a YouTube link) |
| `PATCH /videos/{id} {"title"?, "pace_kmh"?, "position_s"?}` | localhost/LAN | edit; a new position also marks it last played |
| `DELETE /videos/{id}` | localhost/LAN | remove |
| `GET /routes` | anyone | routes (no points), active first |
| `GET /routes/{id}` | anyone | one route with its points `[[lat, lon], ...]` |
| `POST /routes/gpx?name=...` (body: the GPX file) | localhost/LAN | import track points (else route points), segments joined; 5 MB max |
| `POST /routes/plan {"waypoints": [[lat, lon], ...]}` | localhost/LAN | walking route from OpenRouteService (2-10 waypoints); not saved |
| `POST /routes {"name", "points"}` | localhost/LAN | save a (planned) route |
| `PATCH /routes/{id} {"name"?, "progress_m"?}` | localhost/LAN | rename, or set/reset progress |
| `PUT /routes/active {"id": n or null}` | localhost/LAN | the route walking moves along |
| `DELETE /routes/{id}` | localhost/LAN | remove |

Control responses are the new status plus `applied_target_kmh`: the target **after** the cap, not
the request echoed. Errors: 403 not allowed from here, 409 not possible now (no WebSocket for this
client, pad not connected, belt still starting), 422 bad input, 503 pad write failed.

**Control rules** (see `access.py`, `service.py`):
- Only from localhost or a private/link-local LAN address. Requests carrying Cloudflare or proxy
  forwarding headers (`Cf-Connecting-Ip`, `X-Forwarded-For`, ...) are remote even though
  `cloudflared` connects from localhost. `[server] allow_remote_control` (default false) lifts this.
- The `Host` header must name this machine (IP, `localhost`, its hostname, or `control_hosts`):
  stops DNS-rebinding pages.
- An `X-Client-Id` header is required. It forces a CORS preflight, and CORS allows GET only, so
  another site's page in a LAN browser cannot control the belt.
- The client must hold `/live?client=<same id>` open from localhost/LAN (stop excepted). When the
  controlling client's last socket closes, the bridge waits `client_grace_s` (5 s) for it to
  return (refresh, Wi-Fi blip), then ramps down to the device minimum at the ramp rate and stops.
  Any client taking control during the ramp-down (start/speed/stop) cancels it.
- All the SpeedController rules below apply (cap, ramp, pin after start, hold, failsafe).

**Sessions** start when the belt first moves (not during the countdown) and end when the pad
reports it stopped or the pad connection drops. A connection that comes back within 60 s with
the pad's counters still running resumes the same session instead of starting a second one. Totals come from the pad's counters, carried
across the resets the pad does while slowing down. At most one sample per second is stored.
Sessions under `min_session_s` (10 s) are dropped. A crash leaves correct totals; the session is
closed on the next start. Database: `bridge/data/walkpad.sqlite` (schema v3: older databases gain
the `videos` and `routes` tables on the next start; sessions are untouched).

**Stats**: local time of the laptop. A streak day needs 60 s of walking; the current streak
still counts until today is over. Fastest average speed only counts sessions of 5+ minutes.

**Routes**: walking moves the active route along: every sample's new session distance is added
to its stored progress (only increases count, so restarts, counter resets or switching routes
never move it back or double-count), up to its end (then `completed_at` is set). Sample
messages carry `route_id` and `route_progress_m`; status carries `route`. The ORS key lives in
`~/.config/walkpad/secrets.env` for the service or `bridge/.env` for dev runs (docs/keys.md).

**UDP** (`[udp] enabled = true`, `host`, `port`): every `sample` message as one JSON datagram,
fire and forget.

Message examples:

```json
{"type": "sample", "t": 1790792206.12, "speed_kmh": 1.5, "distance_m": 40.0, "steps": 71,
 "elapsed_s": 64.0, "belt": "running", "session_id": 12}
{"type": "safety", "kind": "belt_above_cap", "message": "...", "speed_kmh": 1.8, "cap_kmh": 1.5}
```

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
| `storage.py` | SQLite (stdlib `sqlite3`): sessions and per-second samples, crash-safe totals. |
| `recorder.py` | `SessionRecorder`: samples in, sessions out; start/end with the belt, counter resets. |
| `stats.py` | Period totals, streaks, personal bests over finished sessions. |
| `service.py` | `BridgeService`: pad connection loop, controller, recorder, WebSocket/UDP fan-out, client grace period. |
| `access.py` | Who may control: localhost/LAN, tunnel detection, Host check. |
| `server.py` | FastAPI app: endpoints above, CORS, the web app. |
| `udp.py` | `UdpSender`: JSON datagrams. |
| `youtube.py` | YouTube link parsing (id and `t=` start) for the video library. |
| `routes.py` | GPX parsing, route geometry, `RouteProgress` (walked distance -> active route). |
| `ors.py` | OpenRouteService walking directions (stdlib HTTP, key from the environment). |
| `secrets.py` | Secrets from the environment (systemd `EnvironmentFile`) or `bridge/.env`. |
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

## TODO (later)

- `SpeedController` still relies on callers to feed `observe()`. The service and the CLI both do;
  a new caller that forgets would lose above-cap detection and hold. Consider having the
  controller subscribe to the backend itself.

## TODO (web milestone)

- Show the pad's start countdown in the UI. The pad reports it as KingSmith belt states
  9 -> 8 -> 7 (about 1 s each) before 1 (running); today `KsStatus.belt` folds them into
  RUNNING, so the bridge must expose them first (e.g. a `starting` belt state or a countdown
  field in `Sample`, sent over the WebSocket).

## Config

- Non-secret settings: [config.toml](config.toml): `[safety]` limits, `[ble]` address/protocol/timeouts,
  `[server]` listen address, control and CORS rules, grace period, `[storage]` database, `[udp]` output.
- Secrets: `bridge/.env` (git-ignored). See `.env.example`.

## Service: what was verified on the owner's pad (2026-09-30)

Run by Claude against the real pad through `serve` (cap 1.5 km/h, test database), with the owner
walking and reporting what the belt did:

- Start via `POST /control/start` at 1.0 km/h, hold, explicit stop (stops 2.6 s later); the
  session is recorded and appears in `/stats`.
- Controlling client gone: 5 s grace, then ramp down and stop (about 8 s from disconnect to a
  stopped belt). A reconnect within the grace period keeps the belt running.
- SIGINT to the service while walking: stop sent on shutdown, session closed, clean exit.
- Bluetooth off for 3 s while walking: the belt keeps running while the link is down; the
  service reconnects and sends the owed stop first; belt stopped 7.8 s after Bluetooth returned.
- Found and fixed on the way: (1) a stop owed after a lost link was never sent once the
  controller's quick retries had given up (the belt ran 40 s more); (2) a spurious drop during
  setup left a half-open BlueZ link that blocked all reconnects; (3) a bare start (no switch to
  manual mode) was ignored after ~10 min idle; (4) a dropout split one walk into two sessions
  that counted the same minutes twice.
- The pad stops the belt on its own about 35 s after nobody is on it (its own safety feature).

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
