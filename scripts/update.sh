#!/usr/bin/env bash
# Update the bridge laptop: pull, install bridge + web dependencies, build the web app, and
# restart the bridge user service if (and only if) bridge code or its unit file changed.
#
#   ./scripts/update.sh            # or: make update
#   ./scripts/update.sh --restart  # restart the service even if nothing in bridge/ changed
#
# Never restarts while the belt is running (a restart stops the belt): it says so and exits;
# run it again once the belt has stopped. A new web build needs no restart: the bridge picks
# it up on the next page load.
set -euo pipefail

cd "$(dirname "$0")/.."
SERVICE=walkpad-bridge
UNIT_SRC=bridge/systemd/$SERVICE.service
UNIT_DST=$HOME/.config/systemd/user/$SERVICE.service
FORCE_RESTART=0
[[ ${1:-} == --restart ]] && FORCE_RESTART=1

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

step "git pull"
before=$(git rev-parse HEAD)
git pull --ff-only
after=$(git rev-parse HEAD)
changed=$(git diff --name-only "$before" "$after")
if [[ -z $changed ]]; then echo "already up to date"; else echo "$changed" | sed 's/^/  /'; fi

step "bridge dependencies (uv)"
UV=$(command -v uv || echo "$HOME/.local/bin/uv")
[[ -x $UV ]] || { echo "uv not found: see bridge/README.md" >&2; exit 1; }
(cd bridge && "$UV" sync --locked)

step "web dependencies + build (npm)"
if ! command -v node >/dev/null 2>&1; then
  FNM=$(command -v fnm || echo "$HOME/.local/share/fnm/fnm")
  [[ -x $FNM ]] || { echo "Node not found: install it with fnm (see web/README.md)" >&2; exit 1; }
  eval "$("$FNM" env --shell bash)"
fi
if [[ -n ${FNM_MULTISHELL_PATH:-} ]]; then  # fnm manages node in this shell
  (cd web && fnm use --install-if-missing >/dev/null)  # the version in web/.node-version
fi
want=$(tr -d '[:space:]' < web/.node-version)
have=$(node --version | sed 's/^v//; s/\..*//')
[[ $have == "$want" ]] || echo "warning: Node $have, but web/.node-version says $want"
(cd web && npm ci --no-audit --no-fund && npm run build)

step "bridge service"
restart=$FORCE_RESTART
if [[ -f $UNIT_DST ]] && ! cmp -s "$UNIT_SRC" "$UNIT_DST"; then
  cp "$UNIT_SRC" "$UNIT_DST"
  systemctl --user daemon-reload
  echo "unit file updated"
  restart=1
fi
if grep -qE '^bridge/(src/|pyproject\.toml|uv\.lock|config\.toml)' <<<"$changed"; then
  restart=1
fi
if ! systemctl --user is-enabled --quiet "$SERVICE" 2>/dev/null; then
  echo "service not installed; see docs/bridge-service.md"
  exit 0
fi
if [[ $restart == 0 ]]; then
  echo "no bridge changes: service left running (the new web build is live on the next page load)"
  exit 0
fi
port=$(cd bridge && "$UV" run --quiet python -c \
  'from walkpad_bridge.config import load_config; print(load_config().server.port)')
belt=$(curl -fsS --max-time 3 "http://127.0.0.1:$port/status" 2>/dev/null \
  | python3 -c 'import json,sys; print(json.load(sys.stdin).get("belt"))' 2>/dev/null || echo unknown)
if [[ $belt == running || $belt == stopping ]]; then
  echo "NOT restarting: the belt is $belt. Run this again once it has stopped." >&2
  exit 2
fi
systemctl --user restart "$SERVICE"
echo "service restarted (belt was: $belt)"
