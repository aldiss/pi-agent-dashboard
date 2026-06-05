#!/bin/bash
# teardown-test-dashboard.sh — tear down isolated pi-dashboard test-instance.
#
# Cell: dashboard-dev/v1 (PERMANENT cell)
# Sister to spawn-test-dashboard.sh per Lane (C) HYBRID + Joan-43 ratify-canonical (A) pick.
#
# Reads state from /tmp/dashboard-dev-test-instance-state.json (written by spawn).
# Stops dashboard, removes worktree, cleans isolated HOME.
# Idempotent: safe to re-run if no state present.

set -euo pipefail

STATE_FILE="/tmp/dashboard-dev-test-instance-state.json"

if [ ! -f "$STATE_FILE" ]; then
  echo "No test-instance state recorded at $STATE_FILE; nothing to teardown."
  exit 0
fi

echo "=== teardown-test-dashboard.sh ==="
cat "$STATE_FILE"
echo ""

WORKTREE_DIR=$(grep -o '"worktreeDir": *"[^"]*"' "$STATE_FILE" | head -1 | sed 's/.*"worktreeDir": *"\([^"]*\)".*/\1/')
TEST_HOME=$(grep -o '"testHome": *"[^"]*"' "$STATE_FILE" | head -1 | sed 's/.*"testHome": *"\([^"]*\)".*/\1/')
TEST_PORT=$(grep -o '"testPort": *[0-9]*' "$STATE_FILE" | head -1 | sed 's/.*"testPort": *\([0-9]*\).*/\1/')
HEALTH_URL=$(grep -o '"healthUrl": *"[^"]*"' "$STATE_FILE" | head -1 | sed 's/.*"healthUrl": *"\([^"]*\)".*/\1/')
PID_FILE="$TEST_HOME/dashboard.pid"

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$REPO_ROOT"

# 1. Stop dashboard via CLI (graceful)
echo "1/4 Stopping pi-dashboard at port $TEST_PORT..."
if curl -sS -m 2 "$HEALTH_URL" > /dev/null 2>&1; then
  HOME="$TEST_HOME" "$REPO_ROOT/node_modules/.bin/pi-dashboard" stop 2>&1 | head -5 || true
  sleep 2
fi

# 2. Force-kill if still alive (paranoia)
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE" 2>/dev/null || echo "")
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    echo "  Force-killing PID $PID..."
    kill -TERM "$PID" 2>/dev/null || true
    sleep 1
    kill -KILL "$PID" 2>/dev/null || true
  fi
fi

# 3. Remove worktree (git-aware cleanup)
echo "2/4 Removing git worktree at $WORKTREE_DIR..."
if [ -d "$WORKTREE_DIR" ]; then
  git worktree remove --force "$WORKTREE_DIR" 2>/dev/null || rm -rf "$WORKTREE_DIR"
fi
git worktree prune

# 4. Clean isolated HOME
echo "3/4 Cleaning isolated HOME at $TEST_HOME..."
if [ -d "$TEST_HOME" ]; then
  rm -rf "$TEST_HOME"
fi

# 5. Remove state file
echo "4/4 Removing state file $STATE_FILE..."
rm -f "$STATE_FILE"

echo ""
echo "=== TEARDOWN COMPLETE ==="
echo "Worktree:    removed"
echo "Test HOME:   removed"
echo "Port $TEST_PORT: freed"
echo "State file:  removed"
