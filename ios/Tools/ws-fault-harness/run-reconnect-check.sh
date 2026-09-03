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
#        ./run-reconnect-check.sh session-lifecycle # healthy full chat/foreground/idle lifecycle
#        ./run-reconnect-check.sh revalidate-idle # idle healthy socket answers active probes
#        ./run-reconnect-check.sh revalidate-halfopen # half-open socket recovers after probe timeout
#        ./run-reconnect-check.sh cross-origin # A credential must not reach B
#        ./run-reconnect-check.sh auth-reject  # 401 -> authRequired, no backoff
#        ./run-reconnect-check.sh stall    # silent half-open path (keepalive death)
#        ./run-reconnect-check.sh send-loss # send into black hole; must fail, not confirm
#        ./run-reconnect-check.sh send-recover # late real echo recovers row + banner
#        ./run-reconnect-check.sh send-partial-recover # other failed send keeps banner
#        ./run-reconnect-check.sh reset-replay # old seq 100 -> reset -> replay 1/live 2
#        ./run-reconnect-check.sh prompt-cycle # request -> answer B -> authoritative dismiss
#        ./run-reconnect-check.sh prompt-duplicate # recursive second id renders/submits once
#        ./run-reconnect-check.sh queue-loss # connected/no ack -> slow failure
#        ./run-reconnect-check.sh queue-drop # socket close -> failure before deadline
#        ./run-reconnect-check.sh queue-recover # late bridge ack recovers card + banner
#        ./run-reconnect-check.sh model-cache # two calls -> one wire request, cached rows
#        ./run-reconnect-check.sh model-empty # loaded empty, never endless loading
#        ./run-reconnect-check.sh send-same-recover # ack A cannot clear same-value B draft
#        ./run-reconnect-check.sh send-edit-recover # late ack preserves whitespace edit
set -euo pipefail

MODE="${1:-close}"
QUEUE_LATE_ACK=off
MODEL_CYCLE=off
IDLE_FIRST_ACK=off
EDIT_AT=-1
REVALIDATE_AT=-1
REVALIDATE_COUNT=1
REVALIDATE_INTERVAL=0
LIFECYCLE_CYCLE=off
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$HERE/../../PiDashboard/Sources"
KIT="$HERE/../../PiDashboardKit"
WORK="$(mktemp -d)"
PORT="${PORT:-8899}"
ORIGIN_A_URL="http://127.0.0.1:$PORT"
ORIGIN_B_URL="http://localhost:$PORT"
ORIGIN_A_HOST="127.0.0.1:$PORT"
ORIGIN_B_HOST="localhost:$PORT"
TARGET_URL="$ORIGIN_A_URL"
PROBE_SCENARIO=default
trap 'if [ -n "${SRV_PID:-}" ]; then kill "$SRV_PID" 2>/dev/null || true; fi; rm -rf "$WORK"' EXIT

case "$MODE" in
  session-lifecycle)  SERVER_MODE=alive-idle; FAULT_AT=8; BUDGET=36; SEND_AT=-1; LATE_ECHO=off; RESET_CYCLE=off; PROMPT_CYCLE=off; PROMPT_DUPLICATE=off; QUEUE_CYCLE=off; PROMPT_ANSWER=none; COMPETING=single; PROBE_SCENARIO=session-lifecycle; LIFECYCLE_CYCLE=on; LABEL="healthy full session lifecycle with silent idle" ;;
  revalidate-idle)     SERVER_MODE=alive-idle; FAULT_AT=8; BUDGET=18; SEND_AT=-1; LATE_ECHO=off; RESET_CYCLE=off; PROMPT_CYCLE=off; PROMPT_DUPLICATE=off; QUEUE_CYCLE=off; PROMPT_ANSWER=none; COMPETING=single; REVALIDATE_AT=4; REVALIDATE_COUNT=5; REVALIDATE_INTERVAL=3; PROBE_SCENARIO=revalidate-idle; LABEL="five foreground returns on a healthy idle socket" ;;
  revalidate-halfopen) SERVER_MODE=stall; FAULT_AT=3; BUDGET=12; SEND_AT=-1; LATE_ECHO=off; RESET_CYCLE=off; PROMPT_CYCLE=off; PROMPT_DUPLICATE=off; QUEUE_CYCLE=off; PROMPT_ANSWER=none; COMPETING=single; REVALIDATE_AT=2; REVALIDATE_COUNT=5; REVALIDATE_INTERVAL=0.25; PROBE_SCENARIO=revalidate-halfopen; LABEL="repeated foreground returns during a half-open probe" ;;
  cross-origin) SERVER_MODE=alive; FAULT_AT=8; BUDGET=6; SEND_AT=-1; LATE_ECHO=off; RESET_CYCLE=off; PROMPT_CYCLE=off; PROMPT_DUPLICATE=off; QUEUE_CYCLE=off; PROMPT_ANSWER=none; COMPETING=single; PROBE_SCENARIO=cross-origin; LABEL="same-origin negative control followed by foreign-origin connect" ;;
  auth-reject)  SERVER_MODE=auth-reject; FAULT_AT=8; BUDGET=40; SEND_AT=-1; LATE_ECHO=off; RESET_CYCLE=off; PROMPT_CYCLE=off; PROMPT_DUPLICATE=off; QUEUE_CYCLE=off; PROMPT_ANSWER=none; COMPETING=single; PROBE_SCENARIO=auth-reject; LABEL="401 WebSocket upgrade followed by unauthenticated auth status" ;;
  close)        SERVER_MODE=close; FAULT_AT=8; BUDGET=30;  SEND_AT=-1; LATE_ECHO=off; RESET_CYCLE=off; PROMPT_CYCLE=off; PROMPT_DUPLICATE=off; QUEUE_CYCLE=off; PROMPT_ANSWER=none; COMPETING=single; LABEL="server drops the socket every 8s" ;;
  stall)        SERVER_MODE=stall; FAULT_AT=5; BUDGET=120; SEND_AT=-1; LATE_ECHO=off; RESET_CYCLE=off; PROMPT_CYCLE=off; PROMPT_DUPLICATE=off; QUEUE_CYCLE=off; PROMPT_ANSWER=none; COMPETING=single; LABEL="socket goes silently half-open (keepalive must catch it)" ;;
  send-loss)    SERVER_MODE=stall; FAULT_AT=5; BUDGET=45;  SEND_AT=10; LATE_ECHO=off; RESET_CYCLE=off; PROMPT_CYCLE=off; PROMPT_DUPLICATE=off; QUEUE_CYCLE=off; PROMPT_ANSWER=none; COMPETING=single; LABEL="send into a silently half-open socket" ;;
  send-recover)         SERVER_MODE=stall; FAULT_AT=5; BUDGET=48; SEND_AT=10; LATE_ECHO=on;  RESET_CYCLE=off; PROMPT_CYCLE=off; PROMPT_DUPLICATE=off; QUEUE_CYCLE=off; PROMPT_ANSWER=none; COMPETING=single;    LABEL="late server echo recovers an uncertain send" ;;
  send-partial-recover) SERVER_MODE=stall; FAULT_AT=5; BUDGET=50; SEND_AT=10; LATE_ECHO=on;  RESET_CYCLE=off; PROMPT_CYCLE=off; PROMPT_DUPLICATE=off; QUEUE_CYCLE=off; PROMPT_ANSWER=none; COMPETING=competing; LABEL="one recovered send must not hide another failure" ;;
  reset-replay)         SERVER_MODE=close; FAULT_AT=8; BUDGET=18; SEND_AT=-1; LATE_ECHO=off; RESET_CYCLE=on;  PROMPT_CYCLE=off; PROMPT_DUPLICATE=off; QUEUE_CYCLE=off; PROMPT_ANSWER=none; COMPETING=single;    LABEL="server seq 100 resets and rebuilds from seq 1" ;;
  prompt-cycle)         SERVER_MODE=alive; FAULT_AT=8; BUDGET=8; SEND_AT=-1; LATE_ECHO=off; RESET_CYCLE=off; PROMPT_CYCLE=on;  PROMPT_DUPLICATE=off; QUEUE_CYCLE=off; PROMPT_ANSWER=B; COMPETING=single; LABEL="PromptBus request, response, and dismiss" ;;
  prompt-duplicate)     SERVER_MODE=alive; FAULT_AT=8; BUDGET=8; SEND_AT=-1; LATE_ECHO=off; RESET_CYCLE=off; PROMPT_CYCLE=on;  PROMPT_DUPLICATE=on;  QUEUE_CYCLE=off; PROMPT_ANSWER=B; COMPETING=single; LABEL="duplicate PromptBus ids collapse to one control" ;;
  queue-loss)           SERVER_MODE=stall; FAULT_AT=4; BUDGET=15; SEND_AT=5; LATE_ECHO=off; RESET_CYCLE=off; PROMPT_CYCLE=off; PROMPT_DUPLICATE=off; QUEUE_CYCLE=on; PROMPT_ANSWER=none; COMPETING=single; LABEL="queued follow-up receives no bridge acknowledgement" ;;
  queue-drop)           SERVER_MODE=close; FAULT_AT=6; BUDGET=10; SEND_AT=5; LATE_ECHO=off; RESET_CYCLE=off; PROMPT_CYCLE=off; PROMPT_DUPLICATE=off; QUEUE_CYCLE=on; PROMPT_ANSWER=none; COMPETING=single; LABEL="socket closes before queued-send deadline" ;;
  queue-recover)        SERVER_MODE=alive; FAULT_AT=8; BUDGET=16; SEND_AT=3; LATE_ECHO=off; RESET_CYCLE=off; PROMPT_CYCLE=off; PROMPT_DUPLICATE=off; QUEUE_CYCLE=on; QUEUE_LATE_ACK=on; PROMPT_ANSWER=none; MODEL_PROBE=off; COMPETING=single; LABEL="late bridge acknowledgement recovers queued card" ;;
  model-cache)          SERVER_MODE=alive; FAULT_AT=8; BUDGET=6; SEND_AT=-1; LATE_ECHO=off; RESET_CYCLE=off; PROMPT_CYCLE=off; PROMPT_DUPLICATE=off; QUEUE_CYCLE=off; PROMPT_ANSWER=none; MODEL_CYCLE=full; MODEL_PROBE=full; COMPETING=single; LABEL="model catalogue remains cached across second request" ;;
  model-empty)          SERVER_MODE=alive; FAULT_AT=8; BUDGET=6; SEND_AT=-1; LATE_ECHO=off; RESET_CYCLE=off; PROMPT_CYCLE=off; PROMPT_DUPLICATE=off; QUEUE_CYCLE=off; PROMPT_ANSWER=none; MODEL_CYCLE=empty; MODEL_PROBE=empty; COMPETING=single; LABEL="empty model catalogue reaches loaded state" ;;
  send-same-recover)    SERVER_MODE=alive; FAULT_AT=8; BUDGET=16; SEND_AT=3; LATE_ECHO=off; RESET_CYCLE=off; PROMPT_CYCLE=off; PROMPT_DUPLICATE=off; QUEUE_CYCLE=off; PROMPT_ANSWER=none; MODEL_PROBE=off; COMPETING=same; IDLE_FIRST_ACK=on; LABEL="ack A must not clear same-value restored draft B" ;;
  send-edit-recover)    SERVER_MODE=alive; FAULT_AT=8; BUDGET=16; SEND_AT=3; LATE_ECHO=off; RESET_CYCLE=off; PROMPT_CYCLE=off; PROMPT_DUPLICATE=off; QUEUE_CYCLE=off; PROMPT_ANSWER=none; MODEL_PROBE=off; COMPETING=single; IDLE_FIRST_ACK=on; EDIT_AT=10; LABEL="late ack must preserve operator whitespace edit" ;;
  *) echo "unknown mode '$MODE' (want: session-lifecycle | revalidate-idle | revalidate-halfopen | cross-origin | auth-reject | close | stall | send-loss | send-recover | send-partial-recover | reset-replay | prompt-cycle | prompt-duplicate)" >&2; exit 2 ;;
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
if ! ( cd "$WORK" && swift build --disable-sandbox >"$WORK/build.log" 2>&1 ); then
  tail -40 "$WORK/build.log" >&2
  echo "PROBE BUILD FAILED" >&2
  exit 1
fi
[ -x "$WORK/.build/debug/StoreProbe" ] || { echo "PROBE BUILD FAILED (no binary)" >&2; exit 1; }

TRACE="$WORK/trace.jsonl"
MODEL_PROBE="${MODEL_PROBE:-off}"

# Read server-owned connection events only. This assertion is shared by the forced
# two-store control and the positive lifecycle run, so the control proves both fields
# are live measurements rather than counters that happen to stay at one.
socket_trace_stats() {
  awk '
    /"ev":"upgraded"/ {
      accepted += 1
      live += 1
      if (live > max_live) max_live = live
    }
    /"ev":"socket_closed"/ { if (live > 0) live -= 1 }
    END { print accepted + 0, max_live + 0 }
  ' "$1"
}

assert_single_socket_trace() {
  local stats accepted max_live
  stats="$(socket_trace_stats "$1")"
  read -r accepted max_live <<<"$stats"
  [ "$accepted" -eq 1 ] && [ "$max_live" -eq 1 ]
}

print_lifecycle_failure_timeline() {
  local trace_file="$1" probe_file="$2"
  echo "server lifecycle timeline:"
  awk '
    function trace_time(line, value) {
      value = line
      sub(/^\{"t":/, "", value)
      sub(/,.*/, "", value)
      return value + 0
    }
    function connection_number(line, value) {
      value = line
      sub(/.*"connectionNumber":/, "", value)
      sub(/[^0-9].*/, "", value)
      return value
    }
    function enter_idle_if_due(now) {
      if (stage == "foreground-2" && foreground_2_at >= 0 \
          && now - foreground_2_at >= 1) {
        stage = "silent-idle"
      }
    }
    BEGIN {
      stage = "initial"
      foreground_2_at = -1
    }
    /"ev":"upgraded"/ {
      now = trace_time($0)
      enter_idle_if_due(now)
      accepted += 1
      printf "  t=%.2f ACCEPTED#%d connection=%s after=%s\n", \
        now, accepted, connection_number($0), stage
      next
    }
    /"ev":"socket_closed"/ {
      now = trace_time($0)
      enter_idle_if_due(now)
      printf "  t=%.2f socket-closed connection=%s stage=%s\n", \
        now, connection_number($0), stage
      next
    }
    /"ev":"sent","type":"sessions_snapshot"/ {
      now = trace_time($0)
      printf "  t=%.2f snapshot\n", now
      if (accepted == 1) stage = "snapshot"
      next
    }
    /"ev":"rx","type":"subscribe","sessionId":"sess-probe-1"/ {
      now = trace_time($0)
      printf "  t=%.2f subscribe sess-probe-1\n", now
      if (accepted == 1) stage = "first-chat"
      next
    }
    /"ev":"sent","type":"event"/ {
      now = trace_time($0)
      printf "  t=%.2f live event\n", now
      if (accepted == 1) stage = "live"
      next
    }
    /"ev":"sent","type":"session_updated"/ {
      now = trace_time($0)
      printf "  t=%.2f session_updated\n", now
      if (accepted == 1) stage = "update"
      next
    }
    /"ev":"rx_ws_ping"/ {
      now = trace_time($0)
      ping += 1
      if (accepted == 1) {
        if (ping == 1) stage = "foreground-1"
        else if (ping == 2) {
          stage = "foreground-2"
          foreground_2_at = now
        } else stage = "silent-idle"
      }
      printf "  t=%.2f ws-ping#%d stage=%s\n", now, ping, stage
      next
    }
    /"ev":"rx","type":"unsubscribe","sessionId":"sess-probe-1"/ {
      now = trace_time($0)
      printf "  t=%.2f unsubscribe sess-probe-1\n", now
      if (accepted == 1) stage = "left-first"
      next
    }
    /"ev":"rx","type":"subscribe","sessionId":"sess-probe-2"/ {
      now = trace_time($0)
      printf "  t=%.2f subscribe sess-probe-2\n", now
      if (accepted == 1) stage = "second-chat"
      next
    }
  ' "$trace_file"
  echo "client lifecycle checkpoints:"
  grep 'lifecycle ' "$probe_file" | sed 's/^/  /' || true
}

if [ "$MODE" = "session-lifecycle" ]; then
  CONTROL_TRACE="$WORK/control-trace.jsonl"
  node "$HERE/ws-fault-server.mjs" --mode="$SERVER_MODE" --after="$FAULT_AT" --port="$PORT" --lateEcho="$LATE_ECHO" --resetCycle="$RESET_CYCLE" --promptCycle="$PROMPT_CYCLE" --promptDuplicate="$PROMPT_DUPLICATE" --queueCycle="$QUEUE_CYCLE" --queueLateAck="$QUEUE_LATE_ACK" --modelCycle="$MODEL_CYCLE" --idleFirstAck="$IDLE_FIRST_ACK" --lifecycleCycle="$LIFECYCLE_CYCLE" --trace="$CONTROL_TRACE" >"$WORK/control-srv.log" 2>&1 &
  SRV_PID=$!
  sleep 1
  if ! kill -0 "$SRV_PID" 2>/dev/null; then
    cat "$WORK/control-srv.log" >&2
    echo "LIFECYCLE CONTROL SERVER FAILED TO START" >&2
    exit 1
  fi
  if ! "$WORK/.build/debug/StoreProbe" "$TARGET_URL" 5 0 -1 -1 single none off -1 session-lifecycle-control "$ORIGIN_A_URL" "$ORIGIN_B_URL" 1 0 >"$WORK/control-probe.log" 2>&1; then
    cat "$WORK/control-probe.log" >&2
    echo "FAIL: lifecycle must-fail control could not force two real stores online." >&2
    exit 1
  fi
  kill "$SRV_PID" 2>/dev/null || true
  wait "$SRV_PID" 2>/dev/null || true
  SRV_PID=

  read -r CONTROL_CONNECTIONS CONTROL_MAX_LIVE <<<"$(socket_trace_stats "$CONTROL_TRACE")"
  if [ "$CONTROL_CONNECTIONS" -ne 2 ] || [ "$CONTROL_MAX_LIVE" -ne 2 ]; then
    echo "FAIL: lifecycle must-fail control produced ACCEPTED=$CONTROL_CONNECTIONS max-live=$CONTROL_MAX_LIVE; want 2/2." >&2
    exit 1
  fi
  if assert_single_socket_trace "$CONTROL_TRACE"; then
    echo "FAIL: single-socket assertion accepted the forced two-socket control." >&2
    exit 1
  fi
  echo "must-fail control: forced real second socket rejected (ACCEPTED=$CONTROL_CONNECTIONS max-live=$CONTROL_MAX_LIVE)."
fi

node "$HERE/ws-fault-server.mjs" --mode="$SERVER_MODE" --after="$FAULT_AT" --port="$PORT" --lateEcho="$LATE_ECHO" --resetCycle="$RESET_CYCLE" --promptCycle="$PROMPT_CYCLE" --promptDuplicate="$PROMPT_DUPLICATE" --queueCycle="$QUEUE_CYCLE" --queueLateAck="$QUEUE_LATE_ACK" --modelCycle="$MODEL_CYCLE" --idleFirstAck="$IDLE_FIRST_ACK" --lifecycleCycle="$LIFECYCLE_CYCLE" --trace="$TRACE" >"$WORK/srv.log" 2>&1 &
SRV_PID=$!
sleep 1
if ! kill -0 "$SRV_PID" 2>/dev/null; then
  cat "$WORK/srv.log" >&2
  echo "FAULT SERVER FAILED TO START" >&2
  exit 1
fi

echo "running: $LABEL (${BUDGET}s)"
PROBE_OUT="$WORK/probe.log"
PROBE_RESULT=0
"$WORK/.build/debug/StoreProbe" "$TARGET_URL" "$BUDGET" 2 "$REVALIDATE_AT" "$SEND_AT" "$COMPETING" "$PROMPT_ANSWER" "$MODEL_PROBE" "$EDIT_AT" "$PROBE_SCENARIO" "$ORIGIN_A_URL" "$ORIGIN_B_URL" "$REVALIDATE_COUNT" "$REVALIDATE_INTERVAL" | tee "$PROBE_OUT" | grep -E "phase ->|simulating foreground|sending into|competing failure|operator added|responding to prompt|migration |auth attempts|auth credentials|cross-origin|final" || PROBE_RESULT=${PIPESTATUS[0]}
kill $SRV_PID 2>/dev/null || true
sleep 0.3

read -r CONNECTIONS MAX_LIVE <<<"$(socket_trace_stats "$TRACE")"
SUBSCRIBES=$(grep -c '"type":"subscribe"' "$TRACE" || true)
RX_WS_PINGS=$(grep -c '"ev":"rx_ws_ping"' "$TRACE" || true)
APP_UPDATES=$(grep -c '"ev":"sent","type":"session_updated"' "$TRACE" || true)
STALLED_WS_PINGS=$(grep -c '"ev":"rx_ws_ping_stalled"' "$TRACE" || true)
echo
echo "connections=$CONNECTIONS  subscribe frames received=$SUBSCRIBES"

# The check can fail two ways, and both matter: no reconnect at all (nothing was
# exercised), or reconnects that left the chat unsubscribed (the regression).
if [[ "$MODE" != auth-reject && "$MODE" != prompt-* && "$MODE" != queue-loss && "$MODE" != queue-recover \
      && "$MODE" != model-* && "$MODE" != send-same-recover && "$MODE" != send-edit-recover \
      && "$MODE" != revalidate-idle && "$MODE" != session-lifecycle ]] \
    && [ "$CONNECTIONS" -lt 2 ]; then
  echo "FAIL: only $CONNECTIONS connection(s) — the drop never triggered a reconnect," >&2
  echo "      so this run proves nothing. Check the fault server log: $WORK/srv.log" >&2
  exit 1
fi
if [ "$MODE" != "session-lifecycle" ] && [ "$CONNECTIONS" != "$SUBSCRIBES" ]; then
  echo "FAIL: $((CONNECTIONS - SUBSCRIBES)) connection(s) left the chat unsubscribed." >&2
  echo "      The app would look connected while the open chat received nothing." >&2
  exit 1
fi
if [ "$MODE" = "session-lifecycle" ]; then
  FOREGROUND_RETURNS=$(grep -c 'lifecycle foreground return' "$PROBE_OUT" || true)
  SNAPSHOTS=$(grep -c '"ev":"sent","type":"sessions_snapshot"' "$TRACE" || true)
  LIVE_EVENTS=$(grep -c '"ev":"sent","type":"event"' "$TRACE" || true)
  FIRST_SUBSCRIBES=$(grep -c '"type":"subscribe","sessionId":"sess-probe-1"' "$TRACE" || true)
  FIRST_UNSUBSCRIBES=$(grep -c '"type":"unsubscribe","sessionId":"sess-probe-1"' "$TRACE" || true)
  SECOND_SUBSCRIBES=$(grep -c '"type":"subscribe","sessionId":"sess-probe-2"' "$TRACE" || true)
  ACCEPTED_LINE=$(grep -n '"ev":"upgraded"' "$TRACE" | head -1 | cut -d: -f1 || true)
  SNAPSHOT_LINE=$(grep -n '"ev":"sent","type":"sessions_snapshot"' "$TRACE" | head -1 | cut -d: -f1 || true)
  FIRST_SUBSCRIBE_LINE=$(grep -n '"type":"subscribe","sessionId":"sess-probe-1"' "$TRACE" | head -1 | cut -d: -f1 || true)
  LIVE_EVENT_LINE=$(grep -n '"ev":"sent","type":"event"' "$TRACE" | head -1 | cut -d: -f1 || true)
  UPDATE_LINE=$(grep -n '"ev":"sent","type":"session_updated"' "$TRACE" | head -1 | cut -d: -f1 || true)
  FIRST_PING_LINE=$(grep -n '"ev":"rx_ws_ping"' "$TRACE" | sed -n '1s/:.*//p' || true)
  FIRST_UNSUBSCRIBE_LINE=$(grep -n '"type":"unsubscribe","sessionId":"sess-probe-1"' "$TRACE" | head -1 | cut -d: -f1 || true)
  SECOND_SUBSCRIBE_LINE=$(grep -n '"type":"subscribe","sessionId":"sess-probe-2"' "$TRACE" | head -1 | cut -d: -f1 || true)
  SECOND_PING_LINE=$(grep -n '"ev":"rx_ws_ping"' "$TRACE" | sed -n '2s/:.*//p' || true)
  if [ -n "$SECOND_PING_LINE" ]; then
    APPLICATION_FRAMES_DURING_IDLE=$(awk -v after="$SECOND_PING_LINE" 'NR > after && /"ev":"sent"/ { count += 1 } END { print count + 0 }' "$TRACE")
  else
    APPLICATION_FRAMES_DURING_IDLE=-1
  fi

  echo "lifecycle trace: ACCEPTED=$CONNECTIONS max-live=$MAX_LIVE snapshots=$SNAPSHOTS subscribes=$FIRST_SUBSCRIBES+$SECOND_SUBSCRIBES live-events=$LIVE_EVENTS updates=$APP_UPDATES ws-pings=$RX_WS_PINGS idle-app-frames=$APPLICATION_FRAMES_DURING_IDLE"
  if [ "$PROBE_RESULT" -ne 0 ]; then
    echo "FAIL: lifecycle StoreProbe exited $PROBE_RESULT." >&2
    print_lifecycle_failure_timeline "$TRACE" "$PROBE_OUT" >&2
    exit 1
  fi
  if ! assert_single_socket_trace "$TRACE"; then
    echo "FAIL: lifecycle requires ACCEPTED == 1 and max-live == 1; got $CONNECTIONS/$MAX_LIVE." >&2
    print_lifecycle_failure_timeline "$TRACE" "$PROBE_OUT" >&2
    exit 1
  fi
  if [ "$SNAPSHOTS" -ne 1 ] || [ "$FIRST_SUBSCRIBES" -ne 1 ] \
      || [ "$FIRST_UNSUBSCRIBES" -ne 1 ] || [ "$SECOND_SUBSCRIBES" -ne 1 ]; then
    echo "FAIL: lifecycle did not snapshot, open first chat, leave it, and open second chat exactly once." >&2
    exit 1
  fi
  if [ "$LIVE_EVENTS" -ne 1 ] || [ "$APP_UPDATES" -ne 1 ]; then
    echo "FAIL: lifecycle server did not emit exactly one live event and one session_updated frame." >&2
    exit 1
  fi
  if [ "$FOREGROUND_RETURNS" -ne 2 ] || [ "$RX_WS_PINGS" -lt 3 ]; then
    echo "FAIL: lifecycle needs two foreground probes plus a passive 22s control ping; got returns=$FOREGROUND_RETURNS pings=$RX_WS_PINGS." >&2
    exit 1
  fi
  if [ -z "$ACCEPTED_LINE" ] || [ -z "$SNAPSHOT_LINE" ] || [ -z "$FIRST_SUBSCRIBE_LINE" ] \
      || [ -z "$LIVE_EVENT_LINE" ] || [ -z "$UPDATE_LINE" ] \
      || [ -z "$FIRST_PING_LINE" ] || [ -z "$FIRST_UNSUBSCRIBE_LINE" ] \
      || [ -z "$SECOND_SUBSCRIBE_LINE" ] || [ -z "$SECOND_PING_LINE" ] \
      || [ "$ACCEPTED_LINE" -ge "$SNAPSHOT_LINE" ] \
      || [ "$SNAPSHOT_LINE" -ge "$FIRST_SUBSCRIBE_LINE" ] \
      || [ "$FIRST_SUBSCRIBE_LINE" -ge "$LIVE_EVENT_LINE" ] \
      || [ "$LIVE_EVENT_LINE" -ge "$UPDATE_LINE" ] \
      || [ "$UPDATE_LINE" -ge "$FIRST_PING_LINE" ] \
      || [ "$FIRST_PING_LINE" -ge "$FIRST_UNSUBSCRIBE_LINE" ] \
      || [ "$FIRST_UNSUBSCRIBE_LINE" -ge "$SECOND_SUBSCRIBE_LINE" ] \
      || [ "$SECOND_SUBSCRIBE_LINE" -ge "$SECOND_PING_LINE" ]; then
    echo "FAIL: server trace does not preserve snapshot/chat/live/foreground/switch/foreground order." >&2
    exit 1
  fi
  if [ "$APPLICATION_FRAMES_DURING_IDLE" -ne 0 ]; then
    echo "FAIL: server emitted $APPLICATION_FRAMES_DURING_IDLE application frame(s) after the second foreground probe." >&2
    exit 1
  fi
  if ! grep -q 'lifecycle received live event + session_updated' "$PROBE_OUT" \
      || ! grep -q 'lifecycle final: phase=connected viewed=sess-probe-2 sessions=2' "$PROBE_OUT"; then
    echo "FAIL: real DashboardStore did not observe the live frames or finish the idle window connected on session 2." >&2
    grep 'lifecycle' "$PROBE_OUT" >&2 || true
    exit 1
  fi
  echo "PASS: full lifecycle held ACCEPTED == 1 and max-live == 1 through the silent idle window."
elif [ "$MODE" = "revalidate-idle" ]; then
  REVALIDATIONS=$(grep -c 'simulating foreground return' "$PROBE_OUT" || true)
  echo "idle revalidate trace: ACCEPTED=$CONNECTIONS max-live=$MAX_LIVE revalidates=$REVALIDATIONS rx_ws_ping=$RX_WS_PINGS"
  if [ "$PROBE_RESULT" -ne 0 ]; then
    echo "FAIL: idle StoreProbe exited $PROBE_RESULT." >&2
    exit 1
  fi
  if [ "$REVALIDATIONS" -ne 5 ]; then
    echo "FAIL: idle probe drove $REVALIDATIONS revalidations instead of 5." >&2
    exit 1
  fi
  if [ "$CONNECTIONS" -ne 1 ]; then
    echo "FAIL: idle revalidate requires ACCEPTED == 1; got $CONNECTIONS." >&2
    exit 1
  fi
  if [ "$MAX_LIVE" -gt 1 ]; then
    echo "FAIL: idle revalidate reached $MAX_LIVE live sockets; want at most 1." >&2
    exit 1
  fi
  if [ "$RX_WS_PINGS" -ne "$REVALIDATIONS" ]; then
    echo "FAIL: idle revalidate observed $RX_WS_PINGS protocol pings for $REVALIDATIONS foreground returns." >&2
    exit 1
  fi
  if [ "$APP_UPDATES" -ne 0 ]; then
    echo "FAIL: alive-idle emitted $APP_UPDATES periodic application frame(s)." >&2
    exit 1
  fi
  if ! grep -q 'final: phase=connected' "$PROBE_OUT"; then
    echo "FAIL: idle revalidate did not finish connected." >&2
    grep 'final:' "$PROBE_OUT" >&2 || true
    exit 1
  fi
  if grep -q 'phase -> reconnecting' "$PROBE_OUT"; then
    echo "FAIL: idle revalidate entered reconnecting despite a healthy pong." >&2
    exit 1
  fi
  echo "PASS: healthy idle socket answered active probes and kept ACCEPTED == 1."
elif [ "$MODE" = "revalidate-halfopen" ]; then
  REVALIDATIONS=$(grep -c 'simulating foreground return' "$PROBE_OUT" || true)
  FIRST_ACCEPTED_AT=$(awk -F'"t":|,' '/"ev":"upgraded"/ { count += 1; if (count == 1) { print $2; exit } }' "$TRACE")
  SECOND_ACCEPTED_AT=$(awk -F'"t":|,' '/"ev":"upgraded"/ { count += 1; if (count == 2) { print $2; exit } }' "$TRACE")
  if [ -n "$FIRST_ACCEPTED_AT" ] && [ -n "$SECOND_ACCEPTED_AT" ]; then
    RECOVERY_SECONDS=$(awk -v first="$FIRST_ACCEPTED_AT" -v second="$SECOND_ACCEPTED_AT" 'BEGIN { printf "%.2f", second - first }')
  else
    RECOVERY_SECONDS=missing
  fi
  echo "half-open revalidate trace: ACCEPTED=$CONNECTIONS max-live=$MAX_LIVE revalidates=$REVALIDATIONS stalled_ws_ping=$STALLED_WS_PINGS recovery_s=$RECOVERY_SECONDS"
  if [ "$PROBE_RESULT" -ne 0 ]; then
    echo "FAIL: half-open StoreProbe exited $PROBE_RESULT." >&2
    exit 1
  fi
  if [ "$REVALIDATIONS" -ne 5 ]; then
    echo "FAIL: half-open probe drove $REVALIDATIONS revalidations instead of 5." >&2
    exit 1
  fi
  if [ "$CONNECTIONS" -ne 2 ]; then
    echo "FAIL: half-open revalidate requires exactly one additional accepted connection; got $CONNECTIONS total." >&2
    exit 1
  fi
  if [ "$STALLED_WS_PINGS" -lt 1 ]; then
    echo "FAIL: half-open server observed no protocol ping while stalled; the positive control proves nothing." >&2
    exit 1
  fi
  if [ "$RECOVERY_SECONDS" = missing ] \
      || ! awk -v elapsed="$RECOVERY_SECONDS" 'BEGIN { exit !(elapsed < 32) }'; then
    echo "FAIL: half-open recovery did not arrive before the 32s passive deadline." >&2
    exit 1
  fi
  if ! grep -q 'final: phase=connected' "$PROBE_OUT"; then
    echo "FAIL: half-open revalidate did not finish connected." >&2
    grep 'final:' "$PROBE_OUT" >&2 || true
    exit 1
  fi
  echo "PASS: half-open probe timed out once and recovered in ${RECOVERY_SECONDS}s (<32s)."
elif [ "$MODE" = "cross-origin" ]; then
  A_HTTP_REQUESTS=$(grep -c '"ev":"credential_request","transport":"http","path":"/api/health".*"host":"'"$ORIGIN_A_HOST"'"' "$TRACE" || true)
  A_WS_REQUESTS=$(grep -c '"ev":"credential_request","transport":"ws".*"host":"'"$ORIGIN_A_HOST"'"' "$TRACE" || true)
  B_HTTP_REQUESTS=$(grep -c '"ev":"credential_request","transport":"http","path":"/api/health".*"host":"'"$ORIGIN_B_HOST"'"' "$TRACE" || true)
  B_WS_REQUESTS=$(grep -c '"ev":"credential_request","transport":"ws".*"host":"'"$ORIGIN_B_HOST"'"' "$TRACE" || true)
  A_HTTP_COOKIES=$(grep -c '"ev":"credential_request","transport":"http","path":"/api/health".*"host":"'"$ORIGIN_A_HOST"'","cookiePresent":true' "$TRACE" || true)
  A_WS_COOKIES=$(grep -c '"ev":"credential_request","transport":"ws".*"host":"'"$ORIGIN_A_HOST"'","cookiePresent":true' "$TRACE" || true)
  B_HTTP_COOKIES=$(grep -c '"ev":"credential_request","transport":"http","path":"/api/health".*"host":"'"$ORIGIN_B_HOST"'","cookiePresent":true' "$TRACE" || true)
  B_WS_COOKIES=$(grep -c '"ev":"credential_request","transport":"ws".*"host":"'"$ORIGIN_B_HOST"'","cookiePresent":true' "$TRACE" || true)
  A_TOTAL_COOKIES=$(grep -c '"ev":"credential_request".*"host":"'"$ORIGIN_A_HOST"'","cookiePresent":true' "$TRACE" || true)
  B_TOTAL_COOKIES=$(grep -c '"ev":"credential_request".*"host":"'"$ORIGIN_B_HOST"'","cookiePresent":true' "$TRACE" || true)
  echo "cookie trace: A total=$A_TOTAL_COOKIES health=$A_HTTP_COOKIES/$A_HTTP_REQUESTS ws=$A_WS_COOKIES/$A_WS_REQUESTS; B total=$B_TOTAL_COOKIES health=$B_HTTP_COOKIES/$B_HTTP_REQUESTS ws=$B_WS_COOKIES/$B_WS_REQUESTS"
  if [ "$A_HTTP_REQUESTS" -lt 1 ] || [ "$A_WS_REQUESTS" -lt 1 ] \
      || [ "$B_HTTP_REQUESTS" -lt 1 ] || [ "$B_WS_REQUESTS" -lt 1 ]; then
    echo "FAIL: both origins did not exercise both health and WebSocket credential paths." >&2
    exit 1
  fi
  if [ "$A_HTTP_COOKIES" -lt 1 ] || [ "$A_WS_COOKIES" -lt 1 ]; then
    echo "FAIL: same-origin negative control carried no credential, so this run proves nothing." >&2
    exit 1
  fi
  if [ "$B_TOTAL_COOKIES" -ne 0 ]; then
    echo "FAIL: origin B received origin A's credential." >&2
    exit 1
  fi
  if ! grep -q 'migration attributed: legacy=false origin=true' "$PROBE_OUT" \
      || ! grep -q 'migration unattributed: legacy=false deleted=true' "$PROBE_OUT"; then
    echo "FAIL: legacy credential migration controls did not both pass." >&2
    exit 1
  fi
  echo "PASS: B received zero Cookie headers; A health + upgrade negative controls carried credentials."
elif [ "$MODE" = "auth-reject" ]; then
  REJECTED=$(grep -c '"ev":"upgrade_rejected"' "$TRACE" || true)
  AUTH_STATUS_REQUESTS=$(grep -c '"ev":"credential_request","transport":"http","path":"/auth/status"' "$TRACE" || true)
  ATTEMPT_PAIR=$(sed -nE 's/.*attempts=([0-9]+)->([0-9]+).*/\1 \2/p' "$PROBE_OUT" | tail -1)
  ATTEMPTS_AT_AUTH=${ATTEMPT_PAIR%% *}
  ATTEMPTS_AFTER_SOAK=${ATTEMPT_PAIR##* }
  if [ -z "$ATTEMPT_PAIR" ]; then ATTEMPTS_AT_AUTH=-1; ATTEMPTS_AFTER_SOAK=-1; fi
  echo "auth trace: rejected=$REJECTED auth-status=$AUTH_STATUS_REQUESTS attempts=$ATTEMPTS_AT_AUTH->$ATTEMPTS_AFTER_SOAK"
  if ! grep -q 'phase -> authRequired' "$PROBE_OUT"; then
    echo "FAIL: rejected upgrade did not reach authRequired." >&2
    grep 'final:' "$PROBE_OUT" >&2 || true
    exit 1
  fi
  if [ "$REJECTED" -lt 1 ] || [ "$AUTH_STATUS_REQUESTS" -lt 1 ]; then
    echo "FAIL: 401 upgrade and /auth/status discriminator were not both exercised." >&2
    exit 1
  fi
  if [ "$ATTEMPTS_AT_AUTH" -lt 1 ] || [ "$ATTEMPTS_AT_AUTH" -ne "$ATTEMPTS_AFTER_SOAK" ] \
      || [ "$ATTEMPTS_AFTER_SOAK" -ne "$REJECTED" ]; then
    echo "FAIL: connection attempts continued after authRequired." >&2
    exit 1
  fi
  if ! grep -q 'auth credentials: A=absent B=present' "$PROBE_OUT"; then
    echo "FAIL: auth rejection did not clear only origin A." >&2
    grep 'auth credentials:' "$PROBE_OUT" >&2 || true
    exit 1
  fi
  echo "PASS: 401 reached authRequired, backoff stopped, A cleared, and B remained."
elif [ "$MODE" = "send-loss" ]; then
  if ! grep -q 'delivery=failed' "$PROBE_OUT" || ! grep -q 'draft=\[loss probe\]' "$PROBE_OUT"; then
    echo "FAIL: unacknowledged send was not marked failed with its editable draft restored." >&2
    grep 'final:' "$PROBE_OUT" >&2 || true
    exit 1
  fi
  echo "PASS: unacknowledged send became visible failure; no false confirmation."
elif [ "$MODE" = "send-recover" ]; then
  if ! grep -q 'delivery=confirmed' "$PROBE_OUT" || ! grep -q 'failure=none' "$PROBE_OUT" \
      || ! grep -q 'draft=\[\]' "$PROBE_OUT"; then
    echo "FAIL: late echo did not recover both the row and failure banner." >&2
    grep 'final:' "$PROBE_OUT" >&2 || true
    exit 1
  fi
  echo "PASS: late real echo confirmed the same row and retracted the failure banner."
elif [ "$MODE" = "send-partial-recover" ]; then
  if ! grep -q 'delivery=confirmed other=failed' "$PROBE_OUT" || grep -q 'failure=none' "$PROBE_OUT" \
      || ! grep -q 'draft=\[other loss\]' "$PROBE_OUT"; then
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
elif [ "$MODE" = "queue-recover" ]; then
  if ! grep -q 'queue=confirmed' "$PROBE_OUT" || ! grep -q 'failure=none' "$PROBE_OUT" \
      || ! grep -q 'draft=\[\]' "$PROBE_OUT"; then
    echo "FAIL: late queue acknowledgement did not recover card + banner." >&2
    grep 'final:' "$PROBE_OUT" >&2 || true
    exit 1
  fi
  echo "PASS: late queue acknowledgement confirmed card and retracted its banner."
elif [[ "$MODE" == queue-* ]]; then
  if ! grep -q 'queue=failed' "$PROBE_OUT" || grep -q 'failure=none' "$PROBE_OUT" \
      || ! grep -q 'draft=\[loss probe\]' "$PROBE_OUT"; then
    echo "FAIL: unacknowledged queued follow-up did not fail with its draft restored." >&2
    grep 'final:' "$PROBE_OUT" >&2 || true
    exit 1
  fi
  echo "PASS: unacknowledged queued follow-up became failed; banner remains visible."
elif [ "$MODE" = "send-same-recover" ]; then
  if ! grep -q 'confirmed=1 failed=1' "$PROBE_OUT" \
      || ! grep -q 'draft=\[loss probe\]' "$PROBE_OUT" \
      || grep -q 'failure=none' "$PROBE_OUT"; then
    echo "FAIL: ack A cleared or hid same-value failed draft B." >&2
    grep 'final:' "$PROBE_OUT" >&2 || true
    exit 1
  fi
  echo "PASS: ack A confirmed only A; same-value failed B still owns draft + banner."
elif [ "$MODE" = "send-edit-recover" ]; then
  if ! grep -q 'confirmed=1 failed=0' "$PROBE_OUT" \
      || ! grep -q 'failure=none' "$PROBE_OUT" \
      || ! grep -q 'draft=\[loss probe \]' "$PROBE_OUT"; then
    echo "FAIL: late ack erased or altered the operator-owned whitespace edit." >&2
    grep 'final:' "$PROBE_OUT" >&2 || true
    exit 1
  fi
  echo "PASS: late ack settled delivery but preserved byte-exact operator edit."
elif [ "$MODE" = "model-cache" ]; then
  REQUEST_COUNT=$(grep -c '"type":"request_models"' "$TRACE" || true)
  if [ "$REQUEST_COUNT" -ne 1 ] || ! grep -q 'models=2 modelPhase=loaded' "$PROBE_OUT"; then
    echo "FAIL: cached catalogue was hidden/refetched or did not remain loaded." >&2
    grep 'final:' "$PROBE_OUT" >&2 || true
    exit 1
  fi
  echo "PASS: two calls emitted one request; cached two-model catalogue stayed loaded."
elif [ "$MODE" = "model-empty" ]; then
  if ! grep -q 'models=0 modelPhase=loaded' "$PROBE_OUT"; then
    echo "FAIL: loaded-empty catalogue was mistaken for loading/failure." >&2
    grep 'final:' "$PROBE_OUT" >&2 || true
    exit 1
  fi
  echo "PASS: empty catalogue is loaded-empty, not an endless spinner."
elif [[ "$MODE" == prompt-* ]]; then
  RESPONSE_COUNT=$(grep -c '"ev":"rx_prompt_response"' "$TRACE" || true)
  if ! grep -q 'prompts=0' "$PROBE_OUT" \
      || ! grep -q '"ev":"rx_prompt_response".*"answer":"B".*"cancelled":false.*"source":"dashboard-default"' "$TRACE" \
      || [ "$RESPONSE_COUNT" -ne 1 ]; then
    echo "FAIL: PromptBus request did not resolve through exactly one native response + server dismiss." >&2
    grep 'final:' "$PROBE_OUT" >&2 || true
    grep 'rx_prompt_response' "$TRACE" >&2 || true
    exit 1
  fi
  echo "PASS: prompt appeared once, native answered B once, server dismissed it, prompt count returned to zero."
else
  echo "PASS: every connection re-subscribed the open chat."
fi
