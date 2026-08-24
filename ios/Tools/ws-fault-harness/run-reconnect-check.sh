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
set -euo pipefail

MODE="${1:-close}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$HERE/../../PiDashboard/Sources"
KIT="$HERE/../../PiDashboardKit"
WORK="$(mktemp -d)"
PORT="${PORT:-8899}"
trap 'kill ${SRV_PID:-0} 2>/dev/null || true; rm -rf "$WORK"' EXIT

case "$MODE" in
  close) FAULT_AT=8;  BUDGET=30;  LABEL="server drops the socket every 8s" ;;
  stall) FAULT_AT=5;  BUDGET=120; LABEL="socket goes silently half-open (keepalive must catch it)" ;;
  *) echo "unknown mode '$MODE' (want: close | stall)" >&2; exit 2 ;;
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
node "$HERE/ws-fault-server.mjs" --mode="$MODE" --after="$FAULT_AT" --port="$PORT" --trace="$TRACE" >"$WORK/srv.log" 2>&1 &
SRV_PID=$!
sleep 1

echo "running: $LABEL (${BUDGET}s)"
"$WORK/.build/debug/StoreProbe" "http://127.0.0.1:$PORT" "$BUDGET" 2 | grep -E "phase ->|final" || true
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
echo "PASS: every connection re-subscribed the open chat."
