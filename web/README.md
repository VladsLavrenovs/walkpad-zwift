# walkpad-web

Vite + TypeScript, no UI framework. The walking view (world + walker + HUD + controls) and a
stats page, talking to the bridge. Deployed to `walk.connectedovals.com` later; at home it is
served by the bridge itself at `http://<laptop>:8080`, which is the page allowed to control
the belt.

Status: placeholder world, walker, HUD, controls, stats page, OBS view. Works against
`walkpad-bridge serve --fake` and the real pad. No Google 3D tiles yet.

## Install Node (once per machine)

The Node version lives in `web/.node-version` (24; CI reads the same file). Install it with
[fnm](https://github.com/Schniz/fnm), no sudo needed:

```sh
curl -fsSL https://fnm.vercel.app/install | bash   # installs to ~/.local/share/fnm, hooks ~/.bashrc
exec bash                                          # reload the shell
cd web && fnm install && fnm use                   # reads .node-version
node --version                                     # v24.x
```

`fnm` switches to the right version when you `cd` into `web/` (the installer sets
`--use-on-cd`). `scripts/update.sh` loads it on its own, so `make update` works from any shell.

## Develop

```sh
cd bridge && uv run walkpad-bridge serve --fake   # terminal 1: simulated pad on :8080
cd web && npm install && npm run dev              # terminal 2: http://localhost:5173
npm test           # unit tests (vitest)
npm run typecheck  # tsc, no emit
npm run build      # type-check + production build into dist/ (the bridge serves it at /)
```

`npm run dev` proxies `/live`, `/status`, `/sessions`, `/stats` and `/control` to the bridge
(`BRIDGE_DEV_URL`, default `http://localhost:8080`), so the dev page is same-origin with the
bridge and may control the belt, like the page the bridge serves.

To use it for real walks: `npm run build`, then open `http://<laptop>:8080` (the bridge serves
`web/dist`). Rebuild after changes; no bridge restart needed. On the bridge laptop, `make update`
does the pull, install and build in one go (see the root README).

## Pages and modes

- `/` walking view. `#/stats` stats page (streaks, bests, distance per day/week/month, history).
- `?world=<id>` preselects a world (`placeholder`, `overlay`); otherwise the menu choice is
  remembered per browser.
- `?view=obs` for an OBS browser source: transparent background, HUD and walker only, no
  controls, no menus, never a controlling client. Defaults to the `overlay` world (nothing but
  the walker); add `&world=placeholder` for the full scene.

## How it works

| Module | Role |
|---|---|
| `bridge.ts` | `/live` WebSocket (reconnects with backoff) and HTTP API. One client id per browser, kept across reloads, so a refresh is "the same client back" within the bridge's 5 s grace period. |
| `motion.ts` | Samples arrive at 1-2 Hz; this makes them smooth at 60 fps. Speed: EMA (0.6 s). World odometer: speed x dt per frame, never jumps. HUD distance: the same integration held inside the pad's 10 m buckets. Time: interpolated, never ahead of the pad by more than 1.5 s. Cadence: speed / step length, with step length calibrated from the pad's step counter. |
| `walker.ts` | 4-frame back-view sprite, lower centre. 1-2-3-4 = 2 steps, so frame rate follows cadence. 80 ms crossfade between frames, a subtle bob per step, frame 1 when stopped. |
| `worlds/` | `World` interface (`init(container, ctx)`, `update(distance, speed, dt)`, `dispose`, `showsWalker`; `ctx` gives the bridge client, `canEdit()` and `setWalkerVisible()`) and the registry the menu is built from. `placeholder`: flat ground, grid, trees and 100 m signposts on a 2D canvas. `youtube`: see below. `overlay`: nothing (for OBS). |
| `worlds/videosync.ts` | Belt -> video: rate = belt speed / video pace, snapped to `getAvailablePlaybackRates()` with 4 % hysteresis (log scale); pause when the belt stops, play when it moves (muted retry if the browser blocks sound); position reported every 10 s and on pause. Pure logic, unit-tested with a fake player. |
| `controls.ts` | Start (with a chosen speed), big STOP, -/+ 0.5, presets up to the cap; Space/Esc = stop, arrows = -/+. Shows target vs belt speed while ramping, and "Starting…" during the pad's countdown. Shown only when `/status` says `control_allowed`; otherwise a "view only" badge. |
| `stats.ts`, `charts.ts` | Stats page; SVG bar charts (one series, hover tooltips, table view). |
| `app.ts` | Wires it together: connection pill, HUD, BELT_ABOVE_CAP banner, safety toasts, world menu, the render loop. |

Adding a world: implement `World` in `src/worlds/`, add it to `WORLDS` in `src/worlds/index.ts`.

## Routes

`#/routes` lists routes (progress bar; walk this / stop using / reset / rename / delete),
imports GPX files, and plans walks on a Leaflet + OpenStreetMap map: click a start, an end (and
stops in between), "Get walking route" asks the bridge, which asks OpenRouteService (the key
never reaches the browser), then save it. Editing needs the local page.

While a route is active, a minimap (top right) shows it, the walked part and where you are,
and the placeholder world moves by the distance along the route, so the same stretch of route
always has the same scenery. Progress is stored by the bridge, so a long route takes many walks.

| Module | Role |
|---|---|
| `routes/geo.ts` | Distances along a `[lat, lon]` polyline, the point and heading at a distance. |
| `routes/progress.ts` | `RouteTracker`: smooth position along the route between samples (within the pad's 10 m steps). |
| `routes/minimap.ts`, `routes/page.ts`, `routes/map.ts` | Minimap, Routes page, Leaflet/OSM setup. |

New dependency: `leaflet` (the standard small 2D map library; OpenStreetMap tiles, credited).

## Real world (3D) world

Google Photorealistic 3D Tiles in CesiumJS, following the active route. Off unless
`VITE_WORLD_MODE=real` (then it is in the menu); the key setup and the cost guard are in
[docs/keys.md](../docs/keys.md).

- Position = distance along the active route, interpolated every frame (the same smooth route
  position as the minimap). No active route: it waits and requests nothing from Google.
- Heading looks 12 m ahead along the route, damped, so corners become curves.
- Chase camera ~25 m behind, ~15 m above, raised if the 3D tiles (ground, roofs) under it are
  higher; heights sampled from the tiles every 0.3 s and damped.
- Google's attribution (Cesium's credit display) is kept visible at the top left.
- The walker sprite stays as in every other world.
- Before anything is fetched from Google the bridge must grant a session; refused, it falls back
  to the placeholder world with "3D world limit reached — resets tomorrow/next month".
- Cesium is a separate ~5 MB chunk loaded only then; its static assets (~8 MB) are copied to
  `dist/cesium` by a small Vite plugin (`vite.config.ts`). With the world off, Cesium is not in
  the bundle at all.

| Module | Role |
|---|---|
| `worlds/realworld.ts` | The world: session request, Cesium viewer + Google tileset, camera every frame. |
| `worlds/chase.ts` | Pure camera maths (look-ahead heading, angle damping, chase offset, ground clamp), unit-tested. |

New dependency: `cesium` (CesiumJS, the 3D globe engine named in CLAUDE.md).

## YouTube walk world

A walking-tour video, full screen, first person (the walker is hidden; the toolbar's "walker"
box shows it, remembered per browser). Uses the official YouTube IFrame Player API.

- **Videos** opens the library (stored in the bridge's SQLite): paste a YouTube link (watch,
  youtu.be, shorts, live, embed; a `t=` start time is kept), set its **pace**, the walking speed
  of whoever filmed it (default 4.5 km/h). The title comes from YouTube automatically.
- Playback rate = belt speed ÷ pace, e.g. belt 4.0, pace 4.5 → 0.89 → **1×**; belt 3.0 → 0.67
  → **0.75×** (YouTube offers 0.25-2× in 0.25 steps). The toolbar shows the rate.
- The video pauses (dimmed) when the belt stops and plays when it moves; each video resumes
  where the last session left it (saved every 10 s and on pause; restarts from 0 after the end).
- Session stats still come from the pad; the video is only scenery.
- Editing the library needs a local page (like belt control); view-only and OBS pages just play
  the most recently played video. Some videos do not allow embedding: the world says so.

## Config

All config in `web/.env` (git-ignored); see `.env.example`. `VITE_BRIDGE_URL` stays empty when
the page is served by the bridge or by `npm run dev`. Default world mode is `flat` so dev
reloads never hit Google 3D Tiles.

New dev dependency: `vitest` (unit tests; the standard test runner for Vite projects).
