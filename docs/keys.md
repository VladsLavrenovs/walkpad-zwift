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

## Google Maps Platform (3D Tiles)

Later (the "real world" world). It will follow the same rule where possible.
