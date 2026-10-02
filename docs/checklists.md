# Open checklists

Manual checks that cannot be done yet, filed under the prompt (milestone) that makes them
possible. Tick them off there.

## Prompt 4 (bridge service): still open

- [ ] Reboot test (docs/bridge-service.md, "Keep the laptop awake"): after a reboot, without
      logging in, `http://<laptop>:8080/status` answers from the phone with `"connected": true`;
      it still answers after 25+ min at the login screen, and with the lid closed on AC.
- [ ] Login-screen idle suspend set for `gdm` (needs sudo; could not be verified remotely).

## Routes (needs an ORS key)

- [ ] Add `ORS_API_KEY` to `~/.config/walkpad/secrets.env` (docs/keys.md), restart the service.
- [ ] Routes page: plan a walk near home (start, end, "Get walking route"): a sensible path
      along streets, with a distance; "Save & walk it" makes it active.
- [ ] Walk a few minutes: the minimap dot moves, the route card's progress grows; stop, start
      again later: progress continues where it stopped.
- [ ] Import a real GPX file (e.g. exported from a hiking app): name and length look right.

## Real world (needs a Google Map Tiles API key)

- [ ] Key created and restricted (docs/keys.md); `VITE_WORLD_MODE=real` and the key in
      `web/.env`; `make update`.
- [ ] With an active route, choose "Real world (3D)": photorealistic 3D at the route start, the
      walker over it, Google's attribution visible (top left).
- [ ] Walk: the camera follows the route smoothly ~25 m behind / ~15 m above, turns are curves
      (not snaps), it does not dive into buildings or hills.
- [ ] Stats page: the 3D sessions tile counts the load (1 per world load / page reload).
- [ ] Optional: set `max_sessions_per_day = 1` in bridge/config.toml (restart the service), load
      the 3D world twice: the second time it falls back with "limit reached — resets tomorrow".

## Fantasy trail world

- [ ] On the PC (real GPU): "Fantasy trail" world at quality high holds a steady 60 fps while
      walking (debug panel: press `` ` ``); if not, medium/low do.
- [ ] Create a trail (Routes page, a preset), walk it a few minutes, stop, walk again later:
      the same scenery at the same place, progress continues.
- [ ] Free walk (no active route): walk a few minutes, reload or come back later: the world continues
      at the same place (debug panel: `s`), and the next biome arrives within ~1.4 km.
- [ ] Biomes change every 0.5-1.4 km; rain and the day/night cycle look right; the city at the end.
- [ ] Walk through a village, farmlands, a castle town (through the gate), the waterfall valley:
      buildings look right (no gaps between wall pieces, doors and windows in place, roofs on),
      windmill sails turn, waterfalls flow downwards.
- [ ] Time "fixed time": the picker appears; the chosen hour (e.g. 21:30, 07:00) shows at once and
      stays, also after a reload.
- [ ] At night (or "real time" after dark): windows and lanterns glow, stars, fireflies; with
      quality high there is a soft bloom around lights.
- [ ] "⟳ New world" in the fantasy toolbar: pick a starting biome, Generate: a new path and
      scenery starting there, the trail's progress unchanged; on a remote (tunnel) viewer the
      button is disabled.
- [ ] Camera: drag turns around the walker and tilts, wheel (PC) and pinch (phone/tablet) zoom,
      double-click resets; the walker stays on the path at the right size while walking; turning
      towards houses keeps the camera out of them.
- [ ] No visible stutter when new streets appear ahead (debug panel: "build ≤ … ms" stays under ~20).

## Open world, milestone 1a (world map)

- [ ] **Map** (top bar) shows a continent within a couple of seconds; Generate / Random give
      different worlds; the seed is remembered.
- [ ] The world looks natural: coasts with bays and islands, mountains, rivers running to the
      sea, lakes, waterfalls, towns by rivers, castles on hills, roads with bridges, provinces.
- [ ] Zooming in shows the smaller places' names; the arrow keys do not move the map (they
      still change the belt speed, as everywhere).
- [ ] Back to walking: the other worlds (Fantasy trail, YouTube, ...) are unchanged.
- [ ] Saved worlds: "Save this world" on a seed you like, it gets ★ (first one); save a second,
      "Walk here" moves the ★; reload: the map opens on the ★ world. On the public site only
      "View" is offered.

## Open world, milestone 1b (walking the world)

- [ ] World menu → Open world: you stand in your ★ world (a new one: in its first city).
- [ ] Walking moves you forward; A / D turn (never the belt); arrow keys still change the belt
      speed only.
- [ ] Houses, castles, cliffs, lakes and the sea stop you (you slide along walls); rivers can
      be waded.
- [ ] Stop and come back later (or reload): you continue where you were. On the map (M) your
      arrow is where you stood.
- [ ] Compass, place names, the province banner and the minimap look right; 60 fps on the PC
      at high.

## Open world: progression

- [ ] Walking into a village, castle or new province in the Open world shows a toast with XP;
      the XP bar under the compass fills; a level-up shows "Level N!".
- [ ] Profile (top bar): level, XP from walking / discoveries / achievements, achievements with
      progress; unlocked ones with their date.
- [ ] Walks in other worlds also add walking XP. On the world map, discovered places have a ✓.

## Open world: sprites, people and quests

- [ ] Far trees and the forest out to the horizon look right by day and night (no flicker
      where 3D trees turn into sprites at about 190 m); wheat, lavender and grass look full.
- [ ] People walk the streets of villages and towns; quest givers have a gold "!".
- [ ] F near a giver: dialog; F takes the quest (toast, ◆ on compass and minimap), N declines.
- [ ] Walking to the destination finishes the quest by itself (toast, XP); J shows the log.
- [ ] Still 60 fps on the PC at high in a town full of people.

## Prompt 8 (Cloudflare: Workers deploy, Tunnel, Access) — setup: [cloudflare.md](cloudflare.md)

- [ ] `walkpad-tunnel` service active and the tunnel **Healthy** in the dashboard; it comes back
      after a reboot.
- [ ] A push to `main` deploys `walk.connectedovals.com` (Workers Builds log shows
      `build:cloudflare` and `wrangler deploy`); no `*.workers.dev` address answers.
- [ ] From a phone on mobile data: `https://walk.connectedovals.com` asks for the PIN once, then
      shows live data and stats with the "view only" badge and no controls.
- [ ] A private window without signing in: both hostnames show only the Access login.
- [ ] Another website cannot read the bridge: in the browser console on any other site,
      `fetch('https://walkpad-bridge.connectedovals.com/status', {credentials: 'include'})`
      fails, and the bridge logs `refused http /status from origin ...`.

- [ ] Through the tunnel (`https://walkpad-bridge.connectedovals.com`), control is refused:
      `POST /control/stop` with an `X-Client-Id` header returns **403**, while `/status`,
      `/sessions`, `/stats` and the `/live` WebSocket work.
- [ ] `GET /status` through the tunnel reports `"control_allowed": false`.
- [ ] The web app opened through the tunnel (or the Pages deploy pointed at it) shows the
      **"view only" badge** and no controls, and never becomes the controlling client.
- [ ] The same page opened on the LAN (`http://<laptop>:8080`) still shows the controls.
- [ ] Cloudflare Access blocks both hostnames for anyone but the owner's email.
