#!/usr/bin/env bash
# verify-c7-no-widen.sh — C7 gate: prove the FIX-C2 bridgeConnected projection is
# ANNOTATE-ONLY and NEVER widens the guest-visible session set vs current prod.
#
# Re-runnable own-hand (Joan at cutover-authz; consistent with the auth spot-check
# on d90f841). Proof shape:
#   (A) the guest-visibility filter CORE is byte-identical converged-vs-prod —
#       cell-access.ts filterSessions (REST gate) + cell-access-ws.ts
#       filterServerMessageForPrincipal (WS gate) unchanged — so which sessions a
#       guest sees is decided by the SAME code as prod;
#   (B) projectSession is annotate-only (preserves id, adds only bridgeConnected +
#       endedAt status-norm) — proven by the projectSession annotate-only tests;
#   (C) projectSession is applied AFTER/around the unchanged filter (session-routes
#       decorates the already-filtered `visible` set; browser-gateway projects ids
#       the WS filter still governs).
# Exit 0 = C7 holds (no widen). Non-zero = a guest-filter-code change or ordering
# regression on the auth-adjacent surface — BLOCK the cutover + surface to Joan.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

PROD_REF="${1:-d68e3a7}"
CONV_REF="${2:-HEAD}"
GUEST_FILTER_FILES=(
  packages/server/src/cell-access.ts
  packages/server/src/cell-access-ws.ts
)
fail=0
echo "== C7 no-widen-vs-prod: converged '$CONV_REF' vs prod '$PROD_REF' =="

echo "-- (A) guest-visibility filter core byte-identical vs prod? --"
for f in "${GUEST_FILTER_FILES[@]}"; do
  if git diff --quiet "$PROD_REF" "$CONV_REF" -- "$f"; then
    echo "   OK   unchanged: $f"
  else
    echo "   FAIL changed on the auth-adjacent guest gate: $f"
    git diff --stat "$PROD_REF" "$CONV_REF" -- "$f"
    fail=1
  fi
done

echo "-- (C) projectSession applied AFTER the REST guest filter (annotate-only ordering) --"
if grep -q 'cellAccess.filterSessions' packages/server/src/routes/session-routes.ts \
   && grep -q 'visible.map((s) => projectSession' packages/server/src/routes/session-routes.ts; then
  echo "   OK   session-routes decorates the already-filtered visible set"
else
  echo "   FAIL session-routes ordering not verified (projectSession must decorate the guest-filtered set)"
  fail=1
fi

echo "-- (B) projectSession annotate-only (id preserved) — unit proof --"
if HOME="$(mktemp -d)" npx vitest run --project @blackbelt-technology/pi-dashboard-server \
     src/__tests__/session-projection.test.ts >/tmp/c7-projectSession.log 2>&1; then
  echo "   OK   projectSession annotate-only tests pass"
else
  echo "   FAIL projectSession annotate-only tests (see /tmp/c7-projectSession.log)"
  fail=1
fi

if [ "$fail" -eq 0 ]; then
  echo "== C7 PASS: bridgeConnected is annotate-only; guest-visible set == prod =="
  exit 0
else
  echo "== C7 FAIL: block cutover + surface to Joan =="
  exit 1
fi
