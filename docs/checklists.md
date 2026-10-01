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
- [ ] Biomes change every 1-3 km; rain and the day/night cycle look right; the city at the end.
- [ ] Walk through a village, farmlands, a castle town (through the gate), the waterfall valley:
      buildings look right (no gaps between wall pieces, doors and windows in place, roofs on),
      windmill sails turn, waterfalls flow downwards.
- [ ] At night (or "real time" after dark): windows and lanterns glow, stars, fireflies; with
      quality high there is a soft bloom around lights.
- [ ] "⟳ New world" in the fantasy toolbar: pick a starting biome, Generate: a new path and
      scenery starting there, the trail's progress unchanged; on a remote (tunnel) viewer the
      button is disabled.
- [ ] No visible stutter when new streets appear ahead (debug panel: "build ≤ … ms" stays under ~20).

## Prompt 8 (Cloudflare: Pages deploy, Tunnel, Access)

- [ ] Through the tunnel (`https://walkpad-bridge.connectedovals.com`), control is refused:
      `POST /control/stop` with an `X-Client-Id` header returns **403**, while `/status`,
      `/sessions`, `/stats` and the `/live` WebSocket work.
- [ ] `GET /status` through the tunnel reports `"control_allowed": false`.
- [ ] The web app opened through the tunnel (or the Pages deploy pointed at it) shows the
      **"view only" badge** and no controls, and never becomes the controlling client.
- [ ] The same page opened on the LAN (`http://<laptop>:8080`) still shows the controls.
- [ ] Cloudflare Access blocks both hostnames for anyone but the owner's email.
