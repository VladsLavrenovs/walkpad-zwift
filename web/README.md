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
| `worlds/` | `World` interface (`init`, `update(distance, speed, dt)`, `dispose`, `showsWalker`) and the registry the menu is built from. `placeholder`: flat ground, grid, trees and 100 m signposts on a 2D canvas. `overlay`: nothing (for OBS). |
| `controls.ts` | Start (with a chosen speed), big STOP, -/+ 0.5, presets up to the cap; Space/Esc = stop, arrows = -/+. Shows target vs belt speed while ramping, and "Starting…" during the pad's countdown. Shown only when `/status` says `control_allowed`; otherwise a "view only" badge. |
| `stats.ts`, `charts.ts` | Stats page; SVG bar charts (one series, hover tooltips, table view). |
| `app.ts` | Wires it together: connection pill, HUD, BELT_ABOVE_CAP banner, safety toasts, world menu, the render loop. |

Adding a world: implement `World` in `src/worlds/`, add it to `WORLDS` in `src/worlds/index.ts`.

## Config

All config in `web/.env` (git-ignored); see `.env.example`. `VITE_BRIDGE_URL` stays empty when
the page is served by the bridge or by `npm run dev`. Default world mode is `flat` so dev
reloads never hit Google 3D Tiles.

New dev dependency: `vitest` (unit tests; the standard test runner for Vite projects).
