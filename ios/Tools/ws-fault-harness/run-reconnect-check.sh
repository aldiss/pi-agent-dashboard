#!/usr/bin/env bash
# Reconnect regression check — does the open chat re-subscribe after the socket drops?
#
# The defect this guards (fixed in da6cd5f): DashboardStore restarted the stream and
# re-issued `subscribe` on the next line, racing `client.connect()`. The send hit the
# actor before it had a socket, threw `.notConnected`, and was discarded — so after any
# drop the chat was silently unsubscribed forever while the app still showed "connected".
#
# Ground truth is the SERVER's frame log — what actually arrived — not what the client
# believes it sent. PASS requires one `subscribe` per connection.
#
# Runs on the command line: no simulator, no signing, no network. ~45s.
#
# Usage: ./run-reconnect-check.sh          # drop+reconnect (the regression)
#        ./run-reconnect-check.sh stall    # silent half-open path (keepalive death)
#        ./run-reconnect-check.sh send-loss # send into black hole; must fail, not confirm
#        ./run-reconnect-check.sh send-recover # late real echo recovers row + banner
#        ./run-reconnect-check.sh send-partial-recover # other failed send keeps banner
#        ./run-reconnect-check.sh reset-replay # old seq 100 -> reset -> replay 1/live 2
set -euo pipefail

MODE="${1:-close}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$HERE/../../PiDashboard/Sources"
KIT="$HERE/../../PiDashboardKit"
WORK="$(mktemp -d)"
PORT="${PORT:-8899}"
trap 'kill ${SRV_PID:-0} 2>/dev/null || true; rm -rf "$WORK"' EXIT

case "$MODE" in
  close)        SERVER_MODE=close; FAULT_AT=8; BUDGET=30;  SEND_AT=-1; LATE_ECHO=off; RESET_CYCLE=off; COMPETING=single; LABEL="server drops the socket every 8s" ;;
  stall)        SERVER_MODE=stall; FAULT_AT=5; BUDGET=120; SEND_AT=-1; LATE_ECHO=off; RESET_CYCLE=off; COMPETING=single; LABEL="socket goes silently half-open (keepalive must catch it)" ;;
  send-loss)    SERVER_MODE=stall; FAULT_AT=5; BUDGET=45;  SEND_AT=10; LATE_ECHO=off; RESET_CYCLE=off; COMPETING=single; LABEL="send into a silently half-open socket" ;;
  send-recover)         SERVER_MODE=stall; FAULT_AT=5; BUDGET=48; SEND_AT=10; LATE_ECHO=on;  RESET_CYCLE=off; COMPETING=single;    LABEL="late server echo recovers an uncertain send" ;;
  send-partial-recover) SERVER_MODE=stall; FAULT_AT=5; BUDGET=50; SEND_AT=10; LATE_ECHO=on;  RESET_CYCLE=off; COMPETING=competing; LABEL="one recovered send must not hide another failure" ;;
  reset-replay)         SERVER_MODE=close; FAULT_AT=8; BUDGET=18; SEND_AT=-1; LATE_ECHO=off; RESET_CYCLE=on;  COMPETING=single;    LABEL="server seq 100 resets and rebuilds from seq 1" ;;
  *) echo "unknown mode '$MODE' (want: close | stall | send-loss | send-recover | send-partial-recover | reset-replay)" >&2; exit 2 ;;
esac

# Build a throwaway package around the REAL store sources (symlinked, never copied —
# a copy would drift and the check would stop measuring the shipping code).
mkdir -p "$WORK/Sources/StoreProbe"
cat > "$WORK/Package.swift" <<EOF
// swift-tools-version: 6.0
import PackageDescription
let package = Package(
    name: "ReconnectCheck",
    platforms: [.macOS(.v14)],
    dependencies: [.package(path: "$KIT")],
    targets: [.executableTarget(name: "StoreProbe",
        dependencies: [.product(name: "PiDashboardKit", package: "PiDashboardKit")])]
)
EOF
ln -s "$APP/DashboardStore.swift" "$WORK/Sources/StoreProbe/DashboardStore.swift"
ln -s "$APP/FixtureData.swift"    "$WORK/Sources/StoreProbe/FixtureData.swift"
cp "$HERE/probe/Driver.swift" "$HERE/probe/AuthCookieStoreStub.swift" "$WORK/Sources/StoreProbe/"

echo "building probe against $APP/DashboardStore.swift"
( cd "$WORK" && swift build 2>&1 | grep -E "error:" ) && { echo "PROBE BUILD FAILED" >&2; exit 1; } || true
[ -x "$WORK/.build/debug/StoreProbe" ] || { echo "PROBE BUILD FAILED (no binary)" >&2; exit 1; }

TRACE="$WORK/trace.jsonl"
node "$HERE/ws-fault-server.mjs" --mode="$SERVER_MODE" --after="$FAULT_AT" --port="$PORT" --lateEcho="$LATE_ECHO" --resetCycle="$RESET_CYCLE" --trace="$TRACE" >"$WORK/srv.log" 2>&1 &
SRV_PID=$!
sleep 1

echo "running: $LABEL (${BUDGET}s)"
PROBE_OUT="$WORK/probe.log"
"$WORK/.build/debug/StoreProbe" "http://127.0.0.1:$PORT" "$BUDGET" 2 -1 "$SEND_AT" "$COMPETING" | tee "$PROBE_OUT" | grep -E "phase ->|sending into|competing failure|final" || true
kill $SRV_PID 2>/dev/null || true
sleep 0.3

CONNECTIONS=$(grep -c '"ev":"upgraded"' "$TRACE" || true)
SUBSCRIBES=$(grep -c '"type":"subscribe"' "$TRACE" || true)
echo
echo "connections=$CONNECTIONS  subscribe frames received=$SUBSCRIBES"

# The check can fail two ways, and both matter: no reconnect at all (nothing was
# exercised), or reconnects that left the chat unsubscribed (the regression).
if [ "$CONNECTIONS" -lt 2 ]; then
  echo "FAIL: only $CONNECTIONS connection(s) — the drop never triggered a reconnect," >&2
  echo "      so this run proves nothing. Check the fault server log: $WORK/srv.log" >&2
  exit 1
fi
if [ "$CONNECTIONS" != "$SUBSCRIBES" ]; then
  echo "FAIL: $((CONNECTIONS - SUBSCRIBES)) connection(s) left the chat unsubscribed." >&2
  echo "      The app would look connected while the open chat received nothing." >&2
  exit 1
fi
if [ "$MODE" = "send-loss" ]; then
  if ! grep -q 'delivery=failed' "$PROBE_OUT"; then
    echo "FAIL: unacknowledged send was not marked failed." >&2
    grep 'final:' "$PROBE_OUT" >&2 || true
    exit 1
  fi
  echo "PASS: unacknowledged send became visible failure; no false confirmation."
elif [ "$MODE" = "send-recover" ]; then
  if ! grep -q 'delivery=confirmed' "$PROBE_OUT" || ! grep -q 'failure=none' "$PROBE_OUT"; then
    echo "FAIL: late echo did not recover both the row and failure banner." >&2
    grep 'final:' "$PROBE_OUT" >&2 || true
    exit 1
  fi
  echo "PASS: late real echo confirmed the same row and retracted the failure banner."
elif [ "$MODE" = "send-partial-recover" ]; then
  if ! grep -q 'delivery=confirmed other=failed' "$PROBE_OUT" || grep -q 'failure=none' "$PROBE_OUT"; then
    echo "FAIL: recovering one send hid a different failed send/banner." >&2
    grep 'final:' "$PROBE_OUT" >&2 || true
    exit 1
  fi
  echo "PASS: recovered row confirmed; unrelated failed row and banner remain visible."
elif [ "$MODE" = "reset-replay" ]; then
  FINAL=$(grep 'final:' "$PROBE_OUT" | tail -1)
  if [[ "$FINAL" != *'contents=after reset replay|after reset live'* ]] || [[ "$FINAL" == *'before reset'* ]]; then
    echo "FAIL: reset did not replace old history and accept replay/live events in the new sequence namespace." >&2
    echo "$FINAL" >&2
    exit 1
  fi
  echo "PASS: reset discarded seq-100 history and accepted replay 1 + live 2."
else
  echo "PASS: every connection re-subscribed the open chat."
fi
