#!/bin/bash
# CC-r6 NEW-IDENTITY actual-surface isolated dashboard launcher.
# Stages the CANDIDATE worktree (build1-picker-cand-attr @ the NEW commit) — NOT
# the prod worktree. Temp HOME, loopback-forced (NODE_OPTIONS guard), scratch
# ports 8153/8154, reclaim DISABLED, 8s ask_user timeout (temp-HOME config.json).
# Runs THIS candidate worktree's server so it registers the candidate
# packages/extension (with the D1 responder-attribution split) and serves the
# candidate packages/client/dist. Never binds/touches prod :8000/:9999.
set -u
WT="/Users/vdrobkov/build1-picker-cand-e0-wt"      # NEW identity (candidate)
WS="/tmp/build1-ccr6-cand-8153"
export HOME="$WS/state"
export PI_DASHBOARD_NO_RECLAIM=1
export PI_DASHBOARD_ALLOW_MULTIPLE=1
export PI_DASHBOARD_PORT=8153
export PI_DASHBOARD_PI_PORT=8154
# ISOLATION GUARD: pin every spawned session's bridge to THIS scratch gateway so
# it NEVER mDNS-discovers a sibling test dashboard or prod :9999. The bridge reads
# PI_DASHBOARD_URL → pinnedUrl → server-auto-start returns early (no discovery, no
# auto-start), dialing ONLY ws://localhost:8154. Inherited by spawns via buildSpawnEnv.
export PI_DASHBOARD_URL="ws://localhost:8154"
export LOOPBACK_GUARD_LOG="$WS/evidence/loopback-guard.log"
export NODE_OPTIONS="--require $WS/harness/loopback-listen-guard.cjs"
cd "$WT" || exit 1
exec node "$WT/packages/server/bin/pi-dashboard.mjs" start --port 8153 --pi-port 8154 \
  > "$WS/evidence/dash.log" 2>&1
