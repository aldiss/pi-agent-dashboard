#!/bin/bash
# Phase-2 isolated dashboard launcher — MY d520be7 worktree build.
# Temp HOME, loopback-forced (NODE_OPTIONS guard), scratch ports 8133/8134,
# reclaim DISABLED. Never binds/touches prod :8000/:9999.
set -u
WT="/Users/vdrobkov/build1-comms-wt"
WS="/tmp/build1-p2-20260731-8133"
export HOME="$WS/state"
export PI_DASHBOARD_NO_RECLAIM=1
export PI_DASHBOARD_ALLOW_MULTIPLE=1
export PI_DASHBOARD_PORT=8133
export PI_DASHBOARD_PI_PORT=8134
export LOOPBACK_GUARD_LOG="$WS/evidence/loopback-guard.log"
export NODE_OPTIONS="--require $WS/harness/loopback-listen-guard.cjs"
cd "$WT" || exit 1
# Run the worktree server bin DIRECTLY (guarantees d520be7 build, not global).
exec node "$WT/packages/server/bin/pi-dashboard.mjs" start --port 8133 --pi-port 8134 \
  > "$WS/evidence/dash.log" 2>&1
