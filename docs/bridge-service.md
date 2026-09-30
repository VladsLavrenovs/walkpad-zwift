# Bridge service (systemd)

Runs `walkpad-bridge serve` on the Ubuntu laptop, always on. It keeps running when the pad is
off or the phone app has it, and reconnects when it can.

What it serves on `http://<laptop>:8080` (port in `bridge/config.toml`):

- the built web app (`web/dist`) at `/`: open it on any device on the home network;
- live data: WebSocket `/live`; sessions and stats: `/sessions`, `/sessions/{id}`, `/stats`;
- belt control: `/control/start|speed|stop`, **only** from localhost/LAN (never through the
  Cloudflare Tunnel);
- UDP live samples for the Windows receiver, if `[udp] enabled = true`.

It runs as a **user** service (as you, no root). BlueZ lets your user talk to Bluetooth, and
"lingering" starts it at boot without logging in.

## Install

```sh
cd ~/Documents/Projects/walkingpad/walkpad-zwift/bridge
uv sync                                   # creates bridge/.venv, which the unit runs
uv run walkpad-bridge scan                # check: the pad shows up (then set [ble] address)

mkdir -p ~/.config/systemd/user
cp systemd/walkpad-bridge.service ~/.config/systemd/user/
# Moved the repo? Edit WorkingDirectory and ExecStart in the copied file.

systemctl --user daemon-reload
systemctl --user enable --now walkpad-bridge
sudo loginctl enable-linger "$USER"      # start at boot, keep running after logout
```

Check it:

```sh
systemctl --user status walkpad-bridge
curl -s http://localhost:8080/status      # "connected": true once the pad is reached
```

If `ufw` is active, let the home network in (adjust the range to your LAN):

```sh
sudo ufw allow from 192.168.0.0/16 to any port 8080 proto tcp
```

Then open `http://<laptop-ip>:8080` on a phone or PC on the same Wi-Fi.

## Keep the laptop awake (required)

**Why:** if the laptop suspends while you walk, the Bluetooth link drops, and **the belt keeps
running**: the pad does not stop on a lost connection (verified on this pad), and a sleeping
bridge cannot send the stop it owes until the laptop wakes up. The pad's own auto-stop only
kicks in about 35 s after nobody is on the belt. So the bridge laptop must never suspend on its
own while it is on AC power.

**1. Lid close** (systemd-logind). Create a drop-in instead of editing `logind.conf` itself:

```sh
sudo mkdir -p /etc/systemd/logind.conf.d
sudo tee /etc/systemd/logind.conf.d/walkpad-no-lid-suspend.conf <<'EOF'
[Login]
# On AC power (and docked), closing the lid does nothing: the WalkPad bridge must keep running.
HandleLidSwitchExternalPower=ignore
HandleLidSwitchDocked=ignore
# Uncomment to ignore the lid on battery too:
#HandleLidSwitch=ignore
EOF
```

`HandleLidSwitchExternalPower` is the on-AC setting; on battery the laptop still suspends when
closed, which is what you want when you carry it around. If the laptop is always plugged in and
used only as the bridge, set `HandleLidSwitch=ignore` as well. Apply with a reboot (restarting
`systemd-logind` from a desktop session can log you out).

**2. Idle suspend** (GNOME, the session you log in with):

```sh
gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type 'nothing'
```

(Settings -> Power -> "Automatic Suspend" -> off "When Plugged In" does the same.)

**3. Idle suspend at the login screen.** With lingering, the bridge runs at boot before anyone
logs in, and Ubuntu's login screen (GDM) suspends on its own after about 20 minutes idle:

```sh
sudo -u gdm dbus-run-session gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type 'nothing'
```

**Check:**

```sh
systemd-analyze cat-config systemd/logind.conf | grep -i '^HandleLid'
gsettings get org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type    # 'nothing'
sudo -u gdm dbus-run-session gsettings get org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type
```

Then, on AC power, close the lid for a minute: `curl http://<laptop-ip>:8080/status` from the
phone or another machine must keep answering.

## Logs

```sh
journalctl --user -u walkpad-bridge -f            # follow
journalctl --user -u walkpad-bridge --since today
journalctl --user -u walkpad-bridge -p warning    # warnings and worse (safety events, refusals)
```

Worth knowing in the logs: `pad not reachable, retrying` (pad off, or the phone app has it),
`session N started/ended`, `controlling client ... disconnected; waiting 5 s`, `ramping down to a
stop`, `refused control from ...` (someone tried to control from outside the LAN), and anything
CRITICAL (`STOP THE PAD MANUALLY`).

## Day to day

- **One Bluetooth connection at a time.** While the service runs, the KS Fit app and the CLI
  commands (`live`, `speed`, `stop`) cannot reach the pad. Stop the service first:
  `systemctl --user stop walkpad-bridge` (it stops the belt if it is running), and
  `systemctl --user start walkpad-bridge` afterwards.
- **Update:** `git pull && (cd bridge && uv sync) && systemctl --user restart walkpad-bridge`.
  If the unit file changed: copy it again and `systemctl --user daemon-reload` first.
- **Data:** `bridge/data/walkpad.sqlite` (git-ignored). Back it up with
  `sqlite3 bridge/data/walkpad.sqlite ".backup walkpad-backup.sqlite"` (safe while running).
- **Stop behaviour:** stopping or restarting the service stops the belt. If the controlling page
  goes away (tab closed, Wi-Fi drop), the bridge waits `client_grace_s` (5 s) for it to come back,
  then ramps the belt down at the normal ramp rate and stops it.

## Cloudflare Tunnel

Point the tunnel's service at `http://localhost:8080`. Through the tunnel everything is
read-only: the bridge recognises tunnelled requests by Cloudflare's headers (`Cf-Connecting-Ip`
and others), even though `cloudflared` connects from localhost. Keep
`allow_remote_control = false` in `[server]`.

## Troubleshooting

- `status` says `"connected": false` with an error: close KS Fit on the phone, make sure the pad
  is on, and that it is not paired in `bluetoothctl`. The bridge retries every 5 s.
- `Not authorized` / D-Bus errors from BlueZ: the service must run as your user (a `--user`
  unit), not as another system user.
- Port in use: another `serve` (or an old manual run) is still up. `ss -ltnp | grep 8080`.
