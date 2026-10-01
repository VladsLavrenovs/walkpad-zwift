# Cloudflare: web app, tunnel, Access

What you end up with:

```
browser ──https──> walk.connectedovals.com           Cloudflare Worker (static files only)
   │                   └ behind Cloudflare Access (your email only)
   └──https/wss──> walkpad-bridge.connectedovals.com  Cloudflare Tunnel ──> laptop :8080 (bridge)
                       └ same Access application
```

- **The public site is view-only**: live data, the worlds, stats, history. Belt control is only
  offered by the page the bridge itself serves on the home network (`http://<laptop>:8080`).
  Even from home, anything that arrives through the tunnel is "remote" for the bridge: it carries
  Cloudflare's headers, and the bridge refuses control (403) whatever the page does.
- **One Access application** covers both hostnames with one policy: your email. You sign in once
  (a one-time PIN mailed to you); Access then sets its cookie on both hostnames, so the page on
  `walk.` can read from `walkpad-bridge.`.
- **The bridge also checks `Origin`**: requests and WebSockets from any other website are refused
  (403). Allowed: `app_origins` in `bridge/config.toml` (the two hostnames above) and pages on
  localhost or the LAN.
- **Secrets**: the tunnel token lives in `~/.config/walkpad/tunnel.env` on the laptop. Nothing in
  the repo or in the Cloudflare build is secret.

## Why a Worker (static assets) and not Pages

Both host a static site from GitHub for free. Cloudflare now recommends Workers with static
assets for new projects, and new features land there; Pages is maintained but not developed.
The deploy is just `web/wrangler.jsonc` (no Worker code: requests for files never even run one),
the custom domain is declared in that file, and `workers_dev`/`preview_urls` are off so there is
no second, unprotected `*.workers.dev` address. If the site ever needs a bit of server logic,
it goes in the same Worker.

## 0. Before you start

- `connectedovals.com` is a zone in your Cloudflare account (its nameservers point at Cloudflare).
- Zero Trust is set up on the account (free plan; the dashboard walks you through picking a team
  name the first time you open **Zero Trust**).
- The bridge runs as a service on the laptop ([bridge-service.md](bridge-service.md)).

Do the steps in this order: Access first, so neither hostname is ever reachable unprotected.

## 1. Access application (both hostnames, your email only)

Zero Trust → **Access → Applications → Add an application → Self-hosted**.

1. **Name**: `WalkPad`.
2. **Public hostnames**: add two:
   - subdomain `walk`, domain `connectedovals.com`
   - subdomain `walkpad-bridge`, domain `connectedovals.com`
3. **Session duration**: your choice (e.g. 1 week; you sign in again after it).
4. **Policy**: create one: name `Owner`, action **Allow**, rule **Include → Emails →** your email
   address. No other rules or policies.
5. **Login methods**: **One-time PIN** (default) is enough.
6. **Cookie settings** (under advanced/settings):
   - **Eager redirect cookie: on** (the default). After sign-in, Access hops through both
     hostnames and sets its cookie on each; without it, the page cannot read from the bridge
     until you have opened `https://walkpad-bridge.connectedovals.com` yourself once.
   - SameSite: leave the default (Lax). Both hostnames are the same site, so the cookie goes
     along with the page's requests and the WebSocket.
   - CORS settings: leave them off. The page only makes plain GETs (no preflight, which Access
     would refuse) and the bridge sends its own CORS headers.
7. Save.

## 2. Tunnel for the bridge

### Create it (dashboard)

Zero Trust → **Networks → Tunnels → Create a tunnel → Cloudflared**.

1. Name: `walkpad-laptop`.
2. On the "install connector" page, copy the **token** (the long string after `--token` in the
   commands shown). Don't run those commands: the unit below runs the connector as your user.
3. **Public hostname** (next page, or the tunnel's *Public Hostname* tab):
   - subdomain `walkpad-bridge`, domain `connectedovals.com`, path empty
   - service: **HTTP**, URL `localhost:8080` (the bridge's port from `bridge/config.toml`)
   - leave the additional settings at their defaults (WebSockets work out of the box; do not
     set an "HTTP Host Header").

   This also creates the DNS record (`walkpad-bridge` → the tunnel, proxied).

### Run it (laptop)

Install `cloudflared` from Cloudflare's apt repository (needs sudo, once):

```sh
sudo mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
  | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update && sudo apt-get install cloudflared
```

Store the token (only on the laptop), then install the user service:

```sh
mkdir -p ~/.config/walkpad
( umask 077; printf 'TUNNEL_TOKEN=%s\n' 'PASTE-THE-TOKEN-HERE' > ~/.config/walkpad/tunnel.env )

cd ~/Documents/Projects/walkingpad/walkpad-zwift
cp bridge/systemd/walkpad-tunnel.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now walkpad-tunnel
```

Lingering is already on from the bridge service, so the tunnel starts at boot too. `make update`
keeps the unit file current (and restarts the tunnel only when the unit changed).

Check:

```sh
systemctl --user status walkpad-tunnel
journalctl --user -u walkpad-tunnel -n 30     # "Registered tunnel connection" x4
```

The dashboard shows the tunnel as **Healthy**. Opening
`https://walkpad-bridge.connectedovals.com/status` in a browser now asks you to sign in, then
shows JSON with `"control_allowed": false`.

## 3. Web app on Workers (deployed from GitHub)

Dashboard → **Workers & Pages → Create → Workers → Import a repository** (connect GitHub if
asked, and allow access to `walkpad-zwift` only).

- **Project name**: `walkpad-web` (must match `name` in `web/wrangler.jsonc`)
- **Production branch**: `main`
- **Root directory** (advanced): `web`
- **Build command**: `npm ci && npm run build:cloudflare`
- **Deploy command**: `npx wrangler deploy`
- **Build variables**: none needed. `npm run build:cloudflare` reads `web/.env.cloudflare` (in git,
  nothing secret): `VITE_BRIDGE_URL=https://walkpad-bridge.connectedovals.com`, the flat world,
  no Google key. To point a build elsewhere, set the same variable here; it wins over the file.

Every push to `main` now builds and deploys. The first deploy also creates the custom domain
`walk.connectedovals.com` from `wrangler.jsonc` (with its DNS record). If it fails because a DNS
record for `walk` already exists, delete that record and retry the deploy.

Open `https://walk.connectedovals.com`: sign in with the PIN, and the app shows live data with
the **view only** badge and no controls.

## 4. DNS: what should exist

| Name | Points to | Created by |
|---|---|---|
| `walk.connectedovals.com` | the `walkpad-web` Worker (custom domain) | the first Workers deploy |
| `walkpad-bridge.connectedovals.com` | the `walkpad-laptop` tunnel (CNAME, proxied) | the tunnel's public hostname |

Both proxied (orange cloud). Nothing else is needed; there is no port forwarding on the router.

## 5. Check it

The checks are in [checklists.md](checklists.md) ("Prompt 8"). The short version: from a phone
on mobile data, `https://walk.connectedovals.com` asks for the PIN, then shows live data,
view only; a private window without signing in sees only the Access login on both hostnames.

## Troubleshooting

- **Page loads but stays "connecting"**, console shows CORS or 302 errors to `walkpad-bridge`:
  the Access cookie for the bridge hostname is missing or expired. Reload the page (signing in
  again sets both cookies); check that "Eager redirect cookie" is on. Opening
  `https://walkpad-bridge.connectedovals.com/status` once also sets it.
- **403 `origin not allowed`**: the page's origin is not in `app_origins` (`bridge/config.toml`).
  The bridge logs `refused ... from origin ...`.
- **502 / "tunnel error"**: the bridge is not running (`systemctl --user status walkpad-bridge`)
  or not on the port the tunnel points at.
- **Controls missing at home**: you opened the public site. Control is only on the page the
  bridge serves on the LAN: `http://<laptop>:8080`.
- **Rotating the tunnel token**: Tunnels → `walkpad-laptop` → refresh/regenerate the token, put
  the new one in `~/.config/walkpad/tunnel.env`, `systemctl --user restart walkpad-tunnel`.
