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

## Deploy (Cloudflare)

The public site `https://walk.connectedovals.com` is this app on a Cloudflare Worker (static
assets only, `wrangler.jsonc`), built and deployed by Workers Builds on every push to `main`:
`npm ci && npm run build:cloudflare`, then `npx wrangler deploy` (no wrangler dependency in the
repo; the build image fetches it). Setup: [docs/cloudflare.md](../docs/cloudflare.md).

Configuration per environment, all in Vite env files:

| Where the page runs | Bridge URL | Control |
|---|---|---|
| served by the bridge (`http://<laptop>:8080`), `npm run build` | empty: same origin (`web/.env`, git-ignored) | yes, from localhost/LAN |
| `npm run dev` | empty: Vite proxies to `BRIDGE_DEV_URL` | yes |
| Cloudflare, `npm run build:cloudflare` (`--mode cloudflare`) | `web/.env.cloudflare` (tracked, nothing secret): the tunnel hostname | **view only** |

A page with a bridge URL set is view-only by design: it connects without a client id, never
asks for control, and shows the "view only" badge (the bridge refuses control through the
tunnel anyway). Its GETs carry cookies (`credentials: 'include'`, for the Cloudflare Access
cookie) and stay plain requests without custom headers, because Access refuses CORS preflights.
A Cloudflare build variable of the same name overrides `.env.cloudflare`; the Cloudflare build
has no Google key and the flat world only.

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

## Fantasy trail world

A procedurally generated walk in three.js (`src/worlds/fantasy/`), loaded only when chosen (its
own ~700 KB chunk, plus ~2 MB of models and textures from `public/worlds/fantasy/`).

- **Seeded**: the active trail's seed (or the active route's id; or a per-browser seed for a free
  walk), so the same trail always looks the same.
- **Terrain** in 40 m chunks along a gently winding path (sum of slow seeded sine waves, never
  more than ~35° off course), generated ahead (200-420 m by quality) and disposed 60 m behind.
  At most one piece of work per frame: a chunk's terrain and plants, or (a frame later) its
  buildings.
- **Biomes** in seeded stretches (the first 0.5-0.9 km, villages 0.45-0.8 km, castle towns 0.6-0.8 km,
  the rest 0.65-1.4 km: a new biome every 10-20 minutes at walking pace) that follow
  sensible neighbours and prefer ones not seen for a while, blended over 250 m:
  - **Dark forest**: dense pines, oaks, birches, ferns, mushrooms, dim light, green fog.
  - **Misty elven ruins**: ruined stone houses with ivy, archways over the path, pillars, glowing crystals.
  - **Lakeside meadows**: lush swaying grass, wildflowers, lakes.
  - **Farmlands**: a patchwork of wheat, cabbage, lavender, ploughed and pasture fields; fences
    along the road, hay bales, scarecrows, farmhouses, windmills with turning sails.
  - **Villages**: half-timbered houses on both sides of a cobbled street (a second row behind),
    lanterns, market stalls, barrels, wells.
  - **Castle towns**: a town gate across the road with curtain walls, then a walled castle (corner
    towers, a gate, a keep) beside the street.
  - **Waterfall valley**: cliffs either side (layered rock), a river along the path, waterfalls
    with spray.
  - The **neon night city** covers the last 15 % (at least 1.5 km) of a trail.
- **Buildings** are assembled in code from the modular kit pieces (walls, windows, shutters,
  doors, roofs, gables, chimneys, ivy) and baked per chunk into one mesh per material, with the
  kit's hand-painted textures and normal maps.
- **Sky and light**: a sky dome with sun, moon, twinkling stars and drifting clouds; the sky also
  lights the scene (image-based light, refreshed every 3 s) and reflects in the water. A
  **day/night cycle** (24 real minutes per day, "real time" from your clock, or "fixed time": a
  time of day you pick in the toolbar, e.g. always 21:30): at night the
  windows and lanterns glow and fireflies come out (the city is always at night). Per-biome fog,
  light rain in some 1.5 km zones.
- **Plants** sway in the wind (a vertex shader on grass, crops, ferns and tree crowns).
- **Free walk** (no active route): the world of this browser (`walkpad.fantasy.seed`), and where
  you have got to in it is remembered in this browser too, so each walk continues where the last
  one ended (a new world from "New world" starts at 0). The debug panel shows the next biome and
  how far it is.
- **Trails**: named, fixed-length (Routes page → "New fantasy trail", or a preset), starting in a
  chosen or random biome. They are routes without a map, so progress persists across sessions
  exactly like routes.
- **New world** (toolbar): regenerate with a new seed, starting in a chosen or random biome. For
  the active trail this changes its seed and starting biome on the bridge (progress stays; needs
  local control, read-only viewers see the button disabled); for a free walk it is stored in this
  browser.
- Same smooth motion and damped chase camera maths as the other worlds (7 m behind, 3.2 m up,
  looking 9 m ahead); the walker sprite stays.
- **Camera**: drag to turn around the walker (left/right) and look from lower or higher
  (up/down); mouse wheel or pinch to zoom (0.35× to 4×); double-click or "⟲ Reset camera" for
  the default view. Remembered in this browser; OBS view always uses the default. The camera
  moves in towards the walker rather than into a building, and more terrain is kept behind when
  you look back. The walker sprite is placed by projecting her feet and head from the scene, so
  she stays on the path at the right size; she only has back-view frames, so from the front or
  the side she still shows her back.
- **Quality** (toolbar, remembered):

  | | pixels | ahead | plants drawn | buildings drawn | density | shadows | bloom |
  |---|---|---|---|---|---|---|---|
  | high | 2× | 420 m | 130 m | 270 m | 100 % | 2048 | yes (MSAA ×4) |
  | medium | 1.25× | 300 m | 85 m | 200 m | 60 % | 1024 | no |
  | low | 1× | 200 m | 50 m | 140 m | 35 % | no | no |

  Measured in headless Firefox (this laptop): a village street at high is ~260 draw calls and
  ~1.1 M triangles at 60 fps; a chunk's buildings bake in ≤ 20 ms.
- **Debug panel**: press `` ` `` (backquote): seed, trail, position, biome mix, next biome, time,
  rain, fps, draw calls, triangles, chunks and the slowest recent chunk build, quality.

| Module | Role |
|---|---|
| `fantasy/biomes.ts` | Biome names and the starting-biome list (small, shared with the Routes page). |
| `fantasy/gen.ts` | Pure generation: seeded RNG and noise, `TrailPath`, biome plan and blending, terrain heights, field patchwork, rain, time of day, quality presets, prop scatter, buildings (`house()`, `tower()`, `ruin()`, castles) and waterfalls. Unit-tested. |
| `fantasy/assets.ts` | The kit: loads models and textures, materials, procedural pieces (foundations, battlements, lanterns, windmill, archway), baking a chunk's buildings. |
| `fantasy/props.ts` | Scattered props: stylised trees, grass, crops, rocks, village props (procedural), kit models. |
| `fantasy/freewalk.ts` | Free-walk position kept per browser across page loads. Unit-tested. |
| `fantasy/orbit.ts` | The user camera: orbit/zoom maths, walker sprite placement, keeping out of buildings. Unit-tested. |
| `fantasy/shaders.ts` | Wind sway, sky dome, textured ground (noise, cobbles, cliff rock), waterfalls, glowing particles. |
| `fantasy/world.ts` | three.js scene, chunk streaming, lights, fog, rain, bloom, camera, toolbar, debug panel. |

Assets: Quaternius Medieval Village MegaKit (CC0), credits in
[docs/art/CREDITS.md](../docs/art/CREDITS.md). To re-import (e.g. after changing the list of
models): `python3 web/tools/import_quaternius.py "<path to the kit zip>"` (needs Pillow for the
texture downscaling).

New dependency: `three` (three.js, the standard WebGL library; named in the brief). Post-processing
(bloom) uses three's own addons, nothing new.

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
