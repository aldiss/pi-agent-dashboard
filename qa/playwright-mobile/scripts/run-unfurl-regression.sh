#!/bin/bash
# run-unfurl-regression.sh — one-shot runner for the snapshot-unfurl
# full-scale dashboard regression suite, against an ISOLATED dashboard
# instance on :8001 (pi-port 9998). Never touches the live :8000.
#
# Steps:
#   1. Ensure an isolated dashboard is up on :8001 (spawn if needed, isolated HOME).
#   2. Provision deterministic fixtures (snapshot-unfurl + plain-image + cc-source)
#      and inject the snapshot asset via the pi-gateway.
#   3. Run the Playwright spec across desktop + mobile (iphone-webkit) projects.
#
# Usage:
#   ./qa/playwright-mobile/scripts/run-unfurl-regression.sh
#
# Honors PI_TEST_HOME (default /tmp/pi-unfurl-home), TEST_PORT (8001),
# TEST_PI_PORT (9998).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$REPO_ROOT"

TEST_HOME="${PI_TEST_HOME:-/tmp/pi-unfurl-home}"
TEST_PORT="${TEST_PORT:-8001}"
TEST_PI_PORT="${TEST_PI_PORT:-9998}"
BASE_URL="http://127.0.0.1:${TEST_PORT}"
HEALTH_URL="${BASE_URL}/api/health"

echo "=== run-unfurl-regression.sh ==="
echo "Repo:      $REPO_ROOT"
echo "Test HOME: $TEST_HOME"
echo "Base URL:  $BASE_URL (pi-port $TEST_PI_PORT)"
echo ""

# 1. Ensure isolated dashboard up — seeding fixture FILES first so the server's
#    startup session-scan picks them all up (the server scans sessions ONCE at
#    startup; files written after start are not rescanned without a restart).
if curl -sS -m 2 "$HEALTH_URL" >/dev/null 2>&1; then
  echo "1/3 Dashboard already up at $BASE_URL — restarting so fixtures are scanned ..."
  [ -f "$TEST_HOME/dashboard.pid" ] && kill "$(cat "$TEST_HOME/dashboard.pid")" 2>/dev/null || true
  lsof -nP -iTCP:"$TEST_PORT" -sTCP:LISTEN -t 2>/dev/null | xargs -r kill 2>/dev/null || true
  sleep 1
fi

echo "1/3 Seeding fixture files + spawning isolated dashboard at $BASE_URL ..."
mkdir -p "$TEST_HOME/.pi/dashboard" "$TEST_HOME/.pi/agent/sessions/--Users-dev-my-project--"
cat > "$TEST_HOME/.pi/dashboard/config.json" <<EOF
{
  "port": $TEST_PORT,
  "piPort": $TEST_PI_PORT,
  "autoStart": false,
  "autoShutdown": false,
  "trustedNetworks": ["127.0.0.0/8"],
  "plugins": {
    "federation": {"enabled": false}, "honcho": {"enabled": false},
    "voice-input": {"enabled": false}, "flows": {"enabled": false},
    "flows-anthropic-bridge": {"enabled": false}, "demo": {"enabled": false}
  },
  "openspec": { "pollIntervalSeconds": 9999999, "maxConcurrentSpawns": 0 }
}
EOF
# Seed the session FILES BEFORE starting (so the startup scan sees all three).
PI_TEST_HOME="$TEST_HOME" PI_PI_PORT="$TEST_PI_PORT" \
  node "$REPO_ROOT/qa/playwright-mobile/scripts/spawn-unfurl-fixtures.mjs" --seed-only
( cd "$REPO_ROOT"
  HOME="$TEST_HOME" nohup "$REPO_ROOT/node_modules/.bin/pi-dashboard" start \
    --port "$TEST_PORT" --pi-port "$TEST_PI_PORT" --no-tunnel \
    > "$TEST_HOME/dashboard.log" 2>&1 &
  echo $! > "$TEST_HOME/dashboard.pid" )
for i in $(seq 1 30); do
  curl -sS -m 1 "$HEALTH_URL" >/dev/null 2>&1 && { echo "  healthy after ${i}s ✓"; break; }
  [ "$i" -eq 30 ] && { echo "  FAILED to start"; tail -20 "$TEST_HOME/dashboard.log"; exit 3; }
  sleep 1
done

# 2. Inject the snapshot asset via the (now-running) pi-gateway.
echo "2/3 Injecting snapshot asset via pi-gateway ..."
PI_TEST_HOME="$TEST_HOME" PI_PI_PORT="$TEST_PI_PORT" \
  node "$REPO_ROOT/qa/playwright-mobile/scripts/spawn-unfurl-fixtures.mjs" --inject-only

# Sanity: all three fixture sessions must be listed.
if ! curl -sS -m 2 "${BASE_URL}/api/sessions" | grep -q "bbbbcccc-1111-2222-3333-444455556666"; then
  echo "  ERROR: unfurl session not listed after startup scan — aborting." >&2
  exit 4
fi

# 3. Run the regression spec (desktop + mobile projects)
echo "3/3 Running Playwright regression spec ..."
PI_DASHBOARD_BASE_URL="$BASE_URL" \
  npx playwright test -c "$REPO_ROOT/qa/playwright-mobile" \
    "$REPO_ROOT/qa/playwright-mobile/specs/snapshot-unfurl-regression.spec.ts" \
    --project=desktop-chromium --project=iphone-14-pro-max-portrait \
    "$@"
