#!/usr/bin/env bash
# Pulls the `production` branch and, if it moved, rebuilds and restarts the service. If the build or the health check
# fails it puts the previous version back. Run by confcap-mcp-update.timer every couple of minutes; safe to run by hand
# (`sudo /opt/confcap-mcp/deploy/update.sh`). Does nothing when there is nothing new.
#
# Every setting can be overridden with an environment variable (the tests use that to run it against a scratch repo).
set -euo pipefail

APP_DIR=${APP_DIR:-/opt/confcap-mcp}
REMOTE=${REMOTE:-origin}
BRANCH=${BRANCH:-production}
SERVICE=${SERVICE:-confcap-mcp}
SYSTEMCTL=${SYSTEMCTL:-systemctl}
HEALTH_URL=${HEALTH_URL:-http://127.0.0.1:8787/healthz}
HEALTH_CMD=${HEALTH_CMD:-curl -fsS --max-time 3 $HEALTH_URL}
HEALTH_TRIES=${HEALTH_TRIES:-15}
BUILD_CMD=${BUILD_CMD:-npm ci && npm run build && npm prune --omit=dev}
LOCK=${LOCK:-/run/confcap-mcp-update.lock}

log() { echo "[confcap-mcp-update] $*"; }

exec 9>"$LOCK"
flock -n 9 || { log "another update is running"; exit 0; }

cd "$APP_DIR"
git fetch -q "$REMOTE" "$BRANCH"
new=$(git rev-parse FETCH_HEAD)
old=$(git rev-parse HEAD)
if [ "$new" = "$old" ]; then exit 0; fi

healthy() {
  for _ in $(seq "$HEALTH_TRIES"); do
    if bash -c "$HEALTH_CMD" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

log "updating ${old:0:7} -> ${new:0:7}"
git reset -q --hard "$new"   # a reset (not a merge) so that pointing the branch at an older commit rolls back too

if bash -c "$BUILD_CMD" && $SYSTEMCTL restart "$SERVICE" && healthy; then
  log "now running ${new:0:7}"
  exit 0
fi

log "FAILED: putting ${old:0:7} back"
git reset -q --hard "$old"
bash -c "$BUILD_CMD" || log "rebuilding the previous version also failed"
$SYSTEMCTL restart "$SERVICE" || true
if healthy; then log "previous version is running again"; else log "previous version is NOT healthy: check journalctl -u $SERVICE"; fi
exit 1
