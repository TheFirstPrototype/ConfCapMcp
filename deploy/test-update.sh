#!/usr/bin/env bash
# Tests deploy/update.sh against a scratch git repo with a fake systemctl. No server, no network.  Run: bash deploy/test-update.sh
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
fail=0
ok() { echo "  OK   $1"; }
bad() { echo "  FAIL $1"; fail=1; }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

git init -q --bare "$T/remote.git"
git clone -q "$T/remote.git" "$T/work" 2>/dev/null
cd "$T/work" && git config user.email t@t && git config user.name t && git checkout -q -b production
echo v1 > version && git add . && git commit -qm v1 && git push -q origin production
git clone -q -b production "$T/remote.git" "$T/app" 2>/dev/null
printf '#!/bin/bash\necho "$@" >> %s/systemctl.log\n' "$T" > "$T/systemctl"; chmod +x "$T/systemctl"
HAVE_FLOCK=1
if ! command -v flock >/dev/null; then  # macOS: no flock; a stand-in lets the rest run (the real one is on the server)
  HAVE_FLOCK=0; mkdir "$T/bin"; printf '#!/bin/bash\nexit 0\n' > "$T/bin/flock"; chmod +x "$T/bin/flock"; export PATH="$T/bin:$PATH"
fi

run() { APP_DIR="$T/app" SYSTEMCTL="$T/systemctl" LOCK="$T/lock" HEALTH_TRIES=2 BUILD_CMD="${BUILD:-true}" HEALTH_CMD="${HEALTH:-true}" bash "$HERE/update.sh" 2>&1; }
push() { (cd "$T/work" && echo "$1" > version && git add . && git commit -qm "$1" && git push -q origin production); }
version() { cat "$T/app/version"; }
restarts() { [ -f "$T/systemctl.log" ] && wc -l < "$T/systemctl.log" | tr -d " " || echo 0; }

echo "--- nothing new"
run >/dev/null; check "does nothing and does not restart" '[ "$(restarts)" = 0 ] && [ "$(version)" = v1 ]'

echo "--- a new commit"
push v2; run >/dev/null
check "deploys it" '[ "$(version)" = v2 ]'
check "restarts the service once" '[ "$(restarts)" = 1 ] && grep -q "restart confcap-mcp" "$T/systemctl.log"'

echo "--- the build fails"
push v3; out=$(BUILD=false run); rc=$?
check "keeps the previous version" '[ "$(version)" = v2 ]'
check "reports failure" '[ "$rc" != 0 ] && echo "$out" | grep -q FAILED'

echo "--- the new version never becomes healthy"
before=$(restarts); out=$(HEALTH=false run); rc=$?
check "puts the previous version back" '[ "$(version)" = v2 ]'
check "restarts again to bring it back" '[ "$(restarts)" -gt "$before" ]'

echo "--- a good commit after the bad one"
push v4; run >/dev/null; check "deploys normally" '[ "$(version)" = v4 ]'

echo "--- rolling back by pointing the branch at an older commit"
(cd "$T/work" && git push -q -f origin HEAD~2:production); run >/dev/null
check "follows the branch back" '[ "$(version)" = v2 ]'

echo "--- two updates at once"
if [ $HAVE_FLOCK = 1 ]; then
  push v5; exec 8>"$T/lock"; flock -n 8
  out=$(run); check "the second one waits its turn and changes nothing" '[ "$(version)" = v2 ] && echo "$out" | grep -q "another update"'
  flock -u 8
else
  echo "  SKIP needs flock (not installed here; Linux has it)"
fi

[ $fail = 0 ] && echo "All update checks passed." || { echo "Some update checks FAILED."; exit 1; }
