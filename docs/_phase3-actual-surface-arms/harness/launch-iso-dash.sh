#!/bin/bash
# Actual-surface-arm isolated dashboard launcher — the 1c0769b amended build.
# Temp HOME, loopback-forced (NODE_OPTIONS guard), scratch ports 8153/8154,
# reclaim DISABLED, 8s ask_user timeout (temp-HOME config.json). Runs the
# worktree server DIRECTLY so it registers THIS worktree's packages/extension
# (with markRendered / A1 handler) into the temp-HOME pi settings, and serves
# the freshly-built packages/client/dist. Never binds/touches prod :8000/:9999.
set -u
WT="/Users/vdrobkov/build1-comms-prod-wt"
WS="/tmp/build1-p3-20260731-8153"
export HOME="$WS/state"
export PI_DASHBOARD_NO_RECLAIM=1
export PI_DASHBOARD_ALLOW_MULTIPLE=1
export PI_DASHBOARD_PORT=8153
export PI_DASHBOARD_PI_PORT=8154
export LOOPBACK_GUARD_LOG="$WS/evidence/loopback-guard.log"
export NODE_OPTIONS="--require $WS/harness/loopback-listen-guard.cjs"
cd "$WT" || exit 1
exec node "$WT/packages/server/bin/pi-dashboard.mjs" start --port 8153 --pi-port 8154 \
  > "$WS/evidence/dash.log" 2>&1
