#!/bin/bash
# spawn-test-dashboard.sh — spawn isolated pi-dashboard test-instance for dashboard-dev/v1 per-commit-cycle.
#
# Cell: dashboard-dev/v1 (PERMANENT cell; per-task acceptance contract item #1 empirical regression-test PASS-canonical)
# Per Lane (C) HYBRID + Joan-43 ratify-canonical 2026-06-05 ~13:23 CEST = pick (A) isolated 2nd instance on :8001.
#
# Isolation strategy canonical:
#   - git worktree at /tmp/pi-dashboard-cycle-<short-sha>/  (build-isolation; worktree's dist/client/ separate from production :8000)
#   - isolated HOME at /tmp/pi-test-dashboard-home-<short-sha>/  (config + sessions isolated)
#   - port 8001 + pi-port 9998 (no production-port collision)
#   - operator-production dashboard at :8000 ZERO-DISRUPTION canonical
#
# Operator pacing «постепенно» preserved at-isolation-tier canonical-of-record.
#
# Usage:
#   ./qa/playwright-mobile/scripts/spawn-test-dashboard.sh [<commit-sha-or-branch>]
#
# Default <commit-sha-or-branch> = current HEAD.
# State recorded at /tmp/dashboard-dev-test-instance-state.json for subsequent scripts.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$REPO_ROOT"

CHECKOUT_REF="${1:-HEAD}"
SHORT_SHA=$(git rev-parse --short "$CHECKOUT_REF")
WORKTREE_DIR="/tmp/pi-dashboard-cycle-$SHORT_SHA"
TEST_HOME="/tmp/pi-test-dashboard-home-$SHORT_SHA"
TEST_PORT=8001
TEST_PI_PORT=9998
HEALTH_URL="http://127.0.0.1:${TEST_PORT}/api/health"
STATE_FILE="/tmp/dashboard-dev-test-instance-state.json"

echo "=== spawn-test-dashboard.sh ==="
echo "Repo:        $REPO_ROOT"
echo "Checkout:    $CHECKOUT_REF ($SHORT_SHA)"
echo "Worktree:    $WORKTREE_DIR"
echo "Test HOME:   $TEST_HOME"
echo "Port:        $TEST_PORT (pi-port $TEST_PI_PORT)"
echo ""

# Pre-flight: ensure production port not :8001 (paranoia per operator-pacing-respect canonical)
if curl -sS -m 2 "$HEALTH_URL" > /dev/null 2>&1; then
  echo "ERROR: Something already listening on :$TEST_PORT — aborting to avoid collision." >&2
  curl -sS "$HEALTH_URL" | head -1
  exit 2
fi

# 1. Create git worktree (build-isolation; production dist/client/ untouched)
if [ -d "$WORKTREE_DIR" ]; then
  echo "WARN: worktree already exists at $WORKTREE_DIR — removing + recreating."
  git worktree remove --force "$WORKTREE_DIR" 2>/dev/null || rm -rf "$WORKTREE_DIR"
fi
echo "1/6 Creating git worktree at $WORKTREE_DIR..."
git worktree add "$WORKTREE_DIR" "$CHECKOUT_REF"

# 2. Set up isolated HOME with config.json + seed session
echo "2/6 Setting up isolated HOME at $TEST_HOME..."
rm -rf "$TEST_HOME"
mkdir -p "$TEST_HOME/.pi/dashboard"
mkdir -p "$TEST_HOME/.pi/agent/sessions"

# Copy seed sessions (per seed/active-project canonical; 3 sessions covering UI-state diversity)
cp -r "$REPO_ROOT/seed/active-project/--Users-dev-my-project--" "$TEST_HOME/.pi/agent/sessions/"

# Copy operator-actual Joan-tenure-42 session canonical per substrate r9 spec-canonical default
# (cycle-#1 commit-72381c3 construct-validity-canonical-of-record-AMENDMENT per Joan-43
# operator-ratify (α) 14:55 CEST 2026-06-05; substrate r15 canonical-of-record-LANDED).
# Source path = canonical operator-machine /Users/vdrobkov/.pi/orchestration-state cwd-encoded.
JOAN_SESSION_DIR="$HOME/.pi/agent/sessions/--Users-vdrobkov-.pi-orchestration-state--"
JOAN_SESSION_FILE="2026-06-03T13-12-12-903Z_019e8d9c-ef67-7f8b-936e-494a01f01eb1.jsonl"
JOAN_SESSION_META="2026-06-03T13-12-12-903Z_019e8d9c-ef67-7f8b-936e-494a01f01eb1.meta.json"
if [ -f "$JOAN_SESSION_DIR/$JOAN_SESSION_FILE" ]; then
  mkdir -p "$TEST_HOME/.pi/agent/sessions/--Users-vdrobkov-.pi-orchestration-state--"
  cp "$JOAN_SESSION_DIR/$JOAN_SESSION_FILE" "$TEST_HOME/.pi/agent/sessions/--Users-vdrobkov-.pi-orchestration-state--/" 2>&1 || true
  if [ -f "$JOAN_SESSION_DIR/$JOAN_SESSION_META" ]; then
    cp "$JOAN_SESSION_DIR/$JOAN_SESSION_META" "$TEST_HOME/.pi/agent/sessions/--Users-vdrobkov-.pi-orchestration-state--/" 2>&1 || true
  fi
  JOAN_BYTES=$(wc -c < "$JOAN_SESSION_DIR/$JOAN_SESSION_FILE" | tr -d ' ')
  echo "  + Joan-tenure-42 session copied canonical ($JOAN_BYTES bytes; 019e8d9c... canonical)"
else
  echo "  WARN: Joan-tenure-42 session not present at $JOAN_SESSION_DIR/$JOAN_SESSION_FILE"
fi

# Test-instance config: port 8001, no auto-start, loopback-only auth, no plugins, no openspec
cat > "$TEST_HOME/.pi/dashboard/config.json" <<EOF
{
  "port": $TEST_PORT,
  "piPort": $TEST_PI_PORT,
  "autoStart": false,
  "autoShutdown": false,
  "trustedNetworks": ["127.0.0.0/8"],
  "plugins": {
    "federation": {"enabled": false},
    "honcho": {"enabled": false},
    "voice-input": {"enabled": false},
    "flows": {"enabled": false},
    "flows-anthropic-bridge": {"enabled": false},
    "demo": {"enabled": false}
  },
  "openspec": {
    "pollIntervalSeconds": 9999999,
    "maxConcurrentSpawns": 0
  }
}
EOF

# 3. Build client in worktree (produces worktree-local dist/client/ — production untouched)
echo "3/6 Building client in worktree (worktree-local dist/client/)..."
cd "$WORKTREE_DIR"
# Link node_modules from root to avoid re-install (worktrees share git but not node_modules)
if [ ! -d node_modules ]; then
  ln -s "$REPO_ROOT/node_modules" node_modules
fi
# Link packages/*/node_modules canonical sister-shape per workspace structure
for pkg_nm in "$REPO_ROOT"/packages/*/node_modules; do
  pkg_name=$(basename "$(dirname "$pkg_nm")")
  if [ ! -e "$WORKTREE_DIR/packages/$pkg_name/node_modules" ]; then
    ln -s "$pkg_nm" "$WORKTREE_DIR/packages/$pkg_name/node_modules" 2>/dev/null || true
  fi
done
npm run build 2>&1 | tail -10
cd "$REPO_ROOT"

# 4. Spawn pi-dashboard from worktree cwd with isolated HOME
echo "4/6 Spawning pi-dashboard from worktree cwd (HOME=$TEST_HOME, port=$TEST_PORT)..."
LOG_FILE="$TEST_HOME/dashboard.log"
(
  cd "$WORKTREE_DIR"
  HOME="$TEST_HOME" nohup "$REPO_ROOT/node_modules/.bin/pi-dashboard" start --port "$TEST_PORT" --pi-port "$TEST_PI_PORT" --no-tunnel > "$LOG_FILE" 2>&1 &
  echo $! > "$TEST_HOME/dashboard.pid"
)
sleep 2

# 5. Wait for health (timeout 30s)
echo "5/6 Waiting for test-dashboard health at $HEALTH_URL (timeout 30s)..."
for i in $(seq 1 30); do
  if curl -sS -m 1 "$HEALTH_URL" > /dev/null 2>&1; then
    HEALTH=$(curl -sS "$HEALTH_URL" | head -c 200)
    echo "  health response: $HEALTH"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "ERROR: Test dashboard FAILED to start within 30s. Log tail:" >&2
    tail -30 "$LOG_FILE" >&2 || true
    exit 3
  fi
  sleep 1
done

# 6. Record state for subsequent scripts (teardown + run-commit-cycle)
echo "6/6 Recording state to $STATE_FILE..."
cat > "$STATE_FILE" <<EOF
{
  "checkoutRef": "$CHECKOUT_REF",
  "shortSha": "$SHORT_SHA",
  "worktreeDir": "$WORKTREE_DIR",
  "testHome": "$TEST_HOME",
  "testPort": $TEST_PORT,
  "testPiPort": $TEST_PI_PORT,
  "healthUrl": "$HEALTH_URL",
  "logFile": "$LOG_FILE",
  "spawnedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

echo ""
echo "=== TEST DASHBOARD READY ==="
echo "URL:    http://127.0.0.1:$TEST_PORT"
echo "HOME:   $TEST_HOME"
echo "Log:    $LOG_FILE"
echo "State:  $STATE_FILE"
echo ""
echo "Test sessions available (seed/active-project canonical):"
echo "  - dddd3333-4444-5555-6666-777777777777 (ask_user waiting; 7 lines)"
echo "  - f47ac10b-58cc-4372-a567-0e02b2c3d001 (streaming; 7 lines)"
echo "  - a1b2c3d4-e5f6-7890-abcd-ef1234567890 (completed; 5 lines)"
echo ""
echo "Run Playwright via:"
echo "  PI_DASHBOARD_BASE_URL=http://127.0.0.1:$TEST_PORT \\"
echo "  TEST_SESSION_ID=dddd3333-4444-5555-6666-777777777777 \\"
echo "    npx playwright test -c qa/playwright-mobile qa/playwright-mobile/specs/session-history-load-time.spec.ts"
echo ""
echo "Teardown via: ./qa/playwright-mobile/scripts/teardown-test-dashboard.sh"
