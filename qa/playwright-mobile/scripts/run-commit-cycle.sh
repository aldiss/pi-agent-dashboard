#!/bin/bash
# run-commit-cycle.sh — orchestrate full per-commit-cycle baseline-vs-candidate canonical for dashboard-dev/v1.
#
# Cell: dashboard-dev/v1 (PERMANENT cell)
# Per Lane (C) HYBRID + Joan-43 ratify-canonical (A) pick + per per-task acceptance contract 7-item canonical.
#
# Usage:
#   ./qa/playwright-mobile/scripts/run-commit-cycle.sh <commit-sha> [<test-session-id>]
#
# Args:
#   <commit-sha>       Reverted commit to re-introduce (e.g. 72381c3 for commit-#1 queuedPrompts visibility)
#   <test-session-id>  Override TEST_SESSION_ID (default: dddd3333-4444-5555-6666-777777777777 seed session)
#
# Cycle canonical (per substrate r8 + bootstrap brief per-commit-cycle):
#   1. Spawn test-dashboard from HEAD-worktree (pre-cherry-pick state) at :8001 with isolated HOME
#   2. Baseline Playwright measurement (W1 harness against :8001)
#   3. Cherry-pick <commit-sha> in worktree
#   4. Rebuild client in worktree
#   5. Restart test-dashboard
#   6. Candidate Playwright measurement
#   7. Teardown test-dashboard + worktree + HOME
#   8. Comparison + emit decision-canonical markdown + JSON
#
# Operator pacing «постепенно» preserved canonical-of-record: zero production-disruption at :8000;
# isolated worktree dist/client/ + isolated HOME + isolated port (zero collision with production).

set -euo pipefail

COMMIT="${1:?usage: run-commit-cycle.sh <commit-sha> [<test-session-id>]}"
TEST_SESSION_ID="${2:-dddd3333-4444-5555-6666-777777777777}"

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$REPO_ROOT"

SHORT_SHA=$(git rev-parse --short "$COMMIT")
CYCLE_DIR="$HOME/.pi/cells/dashboard-dev/v1/_cycles/commit-${SHORT_SHA}"
mkdir -p "$CYCLE_DIR"

LOG="$CYCLE_DIR/run-commit-cycle.log"
exec > >(tee -a "$LOG") 2>&1

echo "===================================================="
echo "= run-commit-cycle.sh"
echo "= commit:           $COMMIT ($SHORT_SHA)"
echo "= TEST_SESSION_ID:  $TEST_SESSION_ID"
echo "= cycle-dir:        $CYCLE_DIR"
echo "= started:          $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "===================================================="
echo ""

# Pre-flight: HEAD must be clean enough (allow dirty tree per VelAdvGpt #5 — those artifacts predate cell)
echo "[pre-flight] Recording git state..."
git rev-parse HEAD > "$CYCLE_DIR/head-sha-pre-cycle.txt"
git status --short > "$CYCLE_DIR/git-status-pre-cycle.txt"
echo "HEAD pre-cycle: $(cat $CYCLE_DIR/head-sha-pre-cycle.txt)"
echo ""

# Step 1: Spawn test-dashboard from current HEAD
echo "============================================"
echo "= STEP 1/8: Spawn test-dashboard (pre-cherry-pick state)"
echo "============================================"
"$REPO_ROOT/qa/playwright-mobile/scripts/spawn-test-dashboard.sh" HEAD

STATE_FILE="/tmp/dashboard-dev-test-instance-state.json"
WORKTREE_DIR=$(grep -o '"worktreeDir": *"[^"]*"' "$STATE_FILE" | head -1 | sed 's/.*"worktreeDir": *"\([^"]*\)".*/\1/')
TEST_HOME=$(grep -o '"testHome": *"[^"]*"' "$STATE_FILE" | head -1 | sed 's/.*"testHome": *"\([^"]*\)".*/\1/')
TEST_PORT=$(grep -o '"testPort": *[0-9]*' "$STATE_FILE" | head -1 | sed 's/.*"testPort": *\([0-9]*\).*/\1/')
echo ""

# Step 2: Baseline Playwright measurement
echo "============================================"
echo "= STEP 2/8: Baseline Playwright measurement (pre-cherry-pick)"
echo "============================================"
cd "$REPO_ROOT"
mkdir -p "$CYCLE_DIR/baseline"
PI_DASHBOARD_BASE_URL="http://127.0.0.1:$TEST_PORT" \
TEST_SESSION_ID="$TEST_SESSION_ID" \
PLAYWRIGHT_JSON_OUTPUT_FILE="$CYCLE_DIR/baseline/playwright-results.json" \
  npx playwright test \
  --config qa/playwright-mobile/playwright.config.ts \
  --reporter=json \
  qa/playwright-mobile/specs/session-history-load-time.spec.ts \
  > "$CYCLE_DIR/baseline/playwright-stdout.json" 2>&1 || {
    echo "WARN: baseline Playwright test failures detected (likely measurement-tier; continuing canonical)"
}
echo "Baseline measurement complete: $CYCLE_DIR/baseline/"
ls -la "$CYCLE_DIR/baseline/" 2>&1 | head -10
echo ""

# Step 3: Cherry-pick in worktree
echo "============================================"
echo "= STEP 3/8: Cherry-pick $COMMIT in worktree $WORKTREE_DIR"
echo "============================================"
cd "$WORKTREE_DIR"
if git cherry-pick "$COMMIT" 2>&1 | tee "$CYCLE_DIR/cherry-pick.log"; then
  echo "Cherry-pick clean canonical."
else
  echo "ERROR: cherry-pick conflict canonical; aborting cycle + emitting honest-disclose."
  git cherry-pick --abort 2>&1 || true
  cd "$REPO_ROOT"
  "$REPO_ROOT/qa/playwright-mobile/scripts/teardown-test-dashboard.sh"
  cat > "$CYCLE_DIR/verdict.md" <<EOF
# Cycle verdict — commit \`$SHORT_SHA\` — **DEFER-WITH-HONEST-DISCLOSE**

**Cycle outcome:** cherry-pick conflict canonical at step 3/8; cycle aborted.

**Cherry-pick log:** \`$CYCLE_DIR/cherry-pick.log\`

**Honest-disclose:** cannot proceed empirical-cycle-pass canonical until conflict resolved at-cell-executor + Wizard junction-review canonical.

**Operator-pacing recommendation:** defer to next cycle-window with conflict-resolution-pre-flight.
EOF
  echo "Verdict at: $CYCLE_DIR/verdict.md"
  exit 4
fi
echo ""

# Step 4: Rebuild client in worktree
echo "============================================"
echo "= STEP 4/8: Rebuild client in worktree (worktree-local dist/client/)"
echo "============================================"
npm run build 2>&1 | tee "$CYCLE_DIR/build.log" | tail -10
echo ""

# Step 5: Restart test-dashboard (pi-dashboard restart canonical reads new dist/client/)
echo "============================================"
echo "= STEP 5/8: Restart test-dashboard to pick up new client"
echo "============================================"
cd "$REPO_ROOT"
HOME="$TEST_HOME" "$REPO_ROOT/node_modules/.bin/pi-dashboard" restart 2>&1 | tee "$CYCLE_DIR/restart.log" | tail -10
sleep 3
# Verify health post-restart
HEALTH_URL="http://127.0.0.1:$TEST_PORT/api/health"
if ! curl -sS -m 5 "$HEALTH_URL" > /dev/null 2>&1; then
  echo "ERROR: test-dashboard FAILED to restart cleanly post-cherry-pick."
  "$REPO_ROOT/qa/playwright-mobile/scripts/teardown-test-dashboard.sh"
  exit 5
fi
echo "Test-dashboard restart canonical-of-record + health-OK."
echo ""

# Step 6: Candidate Playwright measurement
echo "============================================"
echo "= STEP 6/8: Candidate Playwright measurement (post-cherry-pick)"
echo "============================================"
mkdir -p "$CYCLE_DIR/candidate"
PI_DASHBOARD_BASE_URL="http://127.0.0.1:$TEST_PORT" \
TEST_SESSION_ID="$TEST_SESSION_ID" \
PLAYWRIGHT_JSON_OUTPUT_FILE="$CYCLE_DIR/candidate/playwright-results.json" \
  npx playwright test \
  --config qa/playwright-mobile/playwright.config.ts \
  --reporter=json \
  qa/playwright-mobile/specs/session-history-load-time.spec.ts \
  > "$CYCLE_DIR/candidate/playwright-stdout.json" 2>&1 || {
    echo "WARN: candidate Playwright test failures detected (likely measurement-tier; continuing canonical)"
}
echo "Candidate measurement complete: $CYCLE_DIR/candidate/"
echo ""

# Step 7: Teardown
echo "============================================"
echo "= STEP 7/8: Teardown test-dashboard"
echo "============================================"
"$REPO_ROOT/qa/playwright-mobile/scripts/teardown-test-dashboard.sh"
echo ""

# Step 8: Comparison + verdict-emit
echo "============================================"
echo "= STEP 8/8: Comparison + verdict-emit"
echo "============================================"
node "$REPO_ROOT/qa/playwright-mobile/scripts/compare-cycle.mjs" \
  --baseline "$CYCLE_DIR/baseline/playwright-results.json" \
  --candidate "$CYCLE_DIR/candidate/playwright-results.json" \
  --commit "$COMMIT" \
  --short-sha "$SHORT_SHA" \
  --output "$CYCLE_DIR/verdict.md" \
  --output-json "$CYCLE_DIR/comparison.json"

echo ""
echo "===================================================="
echo "= CYCLE COMPLETE for commit $SHORT_SHA"
echo "= Verdict:     $CYCLE_DIR/verdict.md"
echo "= Comparison:  $CYCLE_DIR/comparison.json"
echo "= Baseline:    $CYCLE_DIR/baseline/"
echo "= Candidate:   $CYCLE_DIR/candidate/"
echo "= Finished:    $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "===================================================="
