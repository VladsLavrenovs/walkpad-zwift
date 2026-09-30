# Open checklists

Manual checks that cannot be done yet, filed under the prompt (milestone) that makes them
possible. Tick them off there.

## Prompt 4 (bridge service): still open

- [ ] Reboot test (docs/bridge-service.md, "Keep the laptop awake"): after a reboot, without
      logging in, `http://<laptop>:8080/status` answers from the phone with `"connected": true`;
      it still answers after 25+ min at the login screen, and with the lid closed on AC.
- [ ] Login-screen idle suspend set for `gdm` (needs sudo; could not be verified remotely).

## Prompt 8 (Cloudflare: Pages deploy, Tunnel, Access)

- [ ] Through the tunnel (`https://walkpad-bridge.connectedovals.com`), control is refused:
      `POST /control/stop` with an `X-Client-Id` header returns **403**, while `/status`,
      `/sessions`, `/stats` and the `/live` WebSocket work.
- [ ] `GET /status` through the tunnel reports `"control_allowed": false`.
- [ ] The web app opened through the tunnel (or the Pages deploy pointed at it) shows the
      **"view only" badge** and no controls, and never becomes the controlling client.
- [ ] The same page opened on the LAN (`http://<laptop>:8080`) still shows the controls.
- [ ] Cloudflare Access blocks both hostnames for anyone but the owner's email.
