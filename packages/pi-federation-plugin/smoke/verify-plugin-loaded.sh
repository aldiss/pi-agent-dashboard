#!/usr/bin/env bash
# Smoke-test the federation plugin against the live pi-dashboard.
#
# Pre-conditions:
#   - pi-agent-dashboard server running on port 8000 (or PI_DASHBOARD_PORT)
#   - federation plugin manifest discovered (after running `npm run build`
#     OR with `devBuildOnReload: true` in ~/.pi/dashboard/config.json)
#
# Verifies:
#   1. Plugin loaded (visible in /api/health.plugins[])
#   2. /api/federation/peers returns success:true with peer list (may be empty)
#   3. /api/federation/sessions returns success:true with session list (may be empty)
#   4. /api/federation/health returns success:true with health summary
#
# Exits 0 on all-pass, 1 on any failure.
set -euo pipefail

PORT="${PI_DASHBOARD_PORT:-8000}"
BASE="http://localhost:${PORT}"

pass() { printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { printf "  \033[31m✗\033[0m %s\n" "$1"; exit 1; }
info() { printf "  ℹ %s\n" "$1"; }

echo "=== Federation plugin smoke test ==="
echo "Dashboard: $BASE"
echo ""

# 1. Plugin discovered + loaded
echo "1. Plugin loaded?"
HEALTH=$(curl -fsS "$BASE/api/health" 2>&1) || fail "dashboard /api/health unreachable"
PLUGIN_ENTRY=$(echo "$HEALTH" | python3 -c '
import json, sys
d = json.loads(sys.stdin.read())
for p in d.get("plugins", []):
    if p.get("id") == "federation":
        print(json.dumps(p))
        break
' 2>&1)
if [ -z "$PLUGIN_ENTRY" ]; then
  fail "federation plugin not in /api/health.plugins[] — verify manifest was discovered + Vite rebuild ran"
fi
LOADED=$(echo "$PLUGIN_ENTRY" | python3 -c 'import json,sys; print(json.loads(sys.stdin.read()).get("loaded"))')
if [ "$LOADED" != "True" ]; then
  ERR=$(echo "$PLUGIN_ENTRY" | python3 -c 'import json,sys; print(json.loads(sys.stdin.read()).get("error","<no error>"))')
  fail "plugin loaded=False; error: $ERR"
fi
pass "federation plugin loaded; entry: $PLUGIN_ENTRY"

# 2. /api/federation/peers
echo ""
echo "2. GET /api/federation/peers"
PEERS_RESP=$(curl -fsS "$BASE/api/federation/peers" 2>&1) || fail "/api/federation/peers unreachable"
PEERS_OK=$(echo "$PEERS_RESP" | python3 -c 'import json,sys; print(json.loads(sys.stdin.read()).get("success"))')
[ "$PEERS_OK" = "True" ] || fail "/api/federation/peers success=False; resp: $PEERS_RESP"
PEER_COUNT=$(echo "$PEERS_RESP" | python3 -c 'import json,sys; print(len(json.loads(sys.stdin.read()).get("data") or []))')
pass "/api/federation/peers OK ($PEER_COUNT peer(s) configured)"
[ "$PEER_COUNT" -eq 0 ] && info "no peers configured yet — open Settings → Federation to add some"

# 3. /api/federation/sessions
echo ""
echo "3. GET /api/federation/sessions"
SESS_RESP=$(curl -fsS "$BASE/api/federation/sessions" 2>&1) || fail "/api/federation/sessions unreachable"
SESS_OK=$(echo "$SESS_RESP" | python3 -c 'import json,sys; print(json.loads(sys.stdin.read()).get("success"))')
[ "$SESS_OK" = "True" ] || fail "/api/federation/sessions success=False; resp: $SESS_RESP"
SESS_COUNT=$(echo "$SESS_RESP" | python3 -c 'import json,sys; print(len(json.loads(sys.stdin.read()).get("data") or []))')
pass "/api/federation/sessions OK ($SESS_COUNT federated session(s) currently visible)"

# 4. /api/federation/health
echo ""
echo "4. GET /api/federation/health"
H_RESP=$(curl -fsS "$BASE/api/federation/health" 2>&1) || fail "/api/federation/health unreachable"
H_OK=$(echo "$H_RESP" | python3 -c 'import json,sys; print(json.loads(sys.stdin.read()).get("success"))')
[ "$H_OK" = "True" ] || fail "/api/federation/health success=False; resp: $H_RESP"
HEALTHY=$(echo "$H_RESP" | python3 -c 'import json,sys; print(json.loads(sys.stdin.read())["data"]["healthy"])')
pass "/api/federation/health OK (healthy=$HEALTHY); body: $H_RESP"

echo ""
echo "=== ALL PASS ==="
