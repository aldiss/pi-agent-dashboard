#!/bin/bash
# CC-r7 NEW-IDENTITY isolated dashboard launcher. Stages the CANDIDATE worktree
# (build1-picker-cand-attr @ NEW commit 7fc75b5) — NOT prod, NOT build1-comms-prod-wt.
# Temp HOME, loopback-forced guard, scratch ports 8157/8158, reclaim DISABLED,
# 8s ask_user timeout, multi-op config. Every spawned session pinned to THIS
# gateway via PI_DASHBOARD_URL → ISOLATION GUARD (no mDNS, no auto-start).
set -u
WT="/Users/vdrobkov/build1-picker-cand-e0-wt"      # NEW identity (candidate)
WS="/tmp/build1-ccr8-cand-8157"
export HOME="$WS/state"
export PI_DASHBOARD_NO_RECLAIM=1
export PI_DASHBOARD_ALLOW_MULTIPLE=1
export PI_DASHBOARD_PORT=8157
export PI_DASHBOARD_PI_PORT=8158
export PI_DASHBOARD_URL="ws://localhost:8158"
export LOOPBACK_GUARD_LOG="$WS/evidence/loopback-guard.log"
export NODE_OPTIONS="--require $WS/harness/loopback-listen-guard.cjs"
cd "$WT" || exit 1
exec node "$WT/packages/server/bin/pi-dashboard.mjs" start --port 8157 --pi-port 8158 \
  > "$WS/evidence/dash.log" 2>&1
