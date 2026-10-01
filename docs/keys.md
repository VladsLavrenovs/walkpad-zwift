# API keys

Keys never go in the repo and never in the web bundle (anything in `web/.env` with a `VITE_`
prefix is public). The bridge holds them and calls the services itself.

## OpenRouteService (route planner)

Used by the bridge for `POST /routes/plan` (walking directions, profile `foot-walking`). The web
app asks the bridge; it never sees the key. Planning is local-only (it spends the quota), so the
tunnel cannot trigger it.

1. Sign up at <https://openrouteservice.org/dev/> and create a token (free tier: 2,000
   directions per day, 40 per minute: plenty).
2. Put it where the service reads it (this file is outside the repo):

   ```sh
   mkdir -p ~/.config/walkpad
   install -m 600 /dev/null ~/.config/walkpad/secrets.env
   echo 'ORS_API_KEY=paste-your-key-here' >> ~/.config/walkpad/secrets.env
   systemctl --user restart walkpad-bridge   # only with the belt stopped
   ```

   The unit loads it with `EnvironmentFile=-%h/.config/walkpad/secrets.env`. For a manual
   `uv run walkpad-bridge serve`, put the same line in `bridge/.env` (git-ignored) instead.
3. Check: the Routes page, "Plan a walk": two clicks, "Get walking route". Without a key it
   says `ORS_API_KEY is missing on the bridge`; with a wrong key `the ORS key is wrong`.

Errors from ORS are shown with the key scrubbed out.

## Google Maps Platform (Photorealistic 3D Tiles)

Used by the web app's "Real world (3D)" world (CesiumJS). Unlike the ORS key, this one has to be
in the browser (Cesium fetches the tiles directly), so it is in the bundle: **restrict it**.

1. Google Cloud console: enable the **Map Tiles API**, create an API key.
2. Restrict the key: *API restrictions* → Map Tiles API only; *Application restrictions* →
   HTTP referrers: `http://192.168.0.242:8080/*`, `http://localhost:8080/*`,
   `http://localhost:5173/*` (dev), and later `https://walk.connectedovals.com/*`.
3. Optional but wise: set a budget alert and a daily quota cap on the Map Tiles API.
4. `web/.env` (git-ignored):

   ```sh
   VITE_WORLD_MODE=real
   VITE_GOOGLE_MAPS_API_KEY=paste-your-key-here
   ```

   then `make update` (or `npm run build`). Without `VITE_WORLD_MODE=real` the 3D world is not
   even in the menu, and Cesium is not in the bundle.

**Cost guard.** Each 3D world load is one Google session (billable). The app asks the bridge
first (`POST /tiles3d/session`); the bridge grants at most `[google_3d] max_sessions_per_day`
(25) and `max_sessions_per_month` (900), counted in its database, and the app falls back to the
placeholder world with "3D world limit reached — resets tomorrow/next month" beyond that. No
session is requested without an active route. In dev (`npm run dev`) a reload never reopens
the 3D world by itself. Today's and this month's counts are on the stats page.
