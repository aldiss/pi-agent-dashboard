#!/bin/bash
# C2 multi-operator isolated dashboard launcher — staged build (worktree HEAD).
# Temp HOME with MULTI-OP config (requireBrowserAuth:true, operatorUsers,
# secret). Loopback-forced guard, scratch ports 8153/8154, reclaim DISABLED.
# Registers THIS worktree's packages/extension + serves the built client.
set -u
WT="/Users/vdrobkov/build1-comms-prod-wt"
WS="/tmp/build1-p3c2-20260731-8153"
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
