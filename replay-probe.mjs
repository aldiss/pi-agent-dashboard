// Quick empirical WS replay-timing test (Joan-tier exec; will move to Pete post-ratify).
// Connects to local dashboard, subscribes to a session with lastSeq=N, times the replay.
import WebSocket from "ws";

const url = "wss://s-macbook-pro.tail954a35.ts.net/ws";
const sessionId = process.argv[2] || "019e7921-6dbc-7738-84bd-a395b59c5ca4";
const lastSeq = parseInt(process.argv[3] || "200", 10);

console.log(`[probe] connecting to ${url}; sessionId=${sessionId.slice(0,12)}; lastSeq=${lastSeq}`);
const t0 = Date.now();

const ws = new WebSocket(url);
let firstReplayAt = null;
let lastReplayAt = null;
let batchCount = 0;
let totalEventCount = 0;
let isLastSeen = false;
let connectedAt = null;

ws.on("open", () => {
  connectedAt = Date.now();
  console.log(`[probe] WS open at +${connectedAt - t0}ms`);
  ws.send(JSON.stringify({ type: "subscribe", sessionId, lastSeq }));
  console.log(`[probe] subscribe sent at +${Date.now() - t0}ms`);
});

ws.on("message", (data) => {
  const now = Date.now();
  let msg;
  try { msg = JSON.parse(data.toString()); } catch { return; }
  if (msg.type === "event_replay" && msg.sessionId === sessionId) {
    batchCount++;
    totalEventCount += (msg.events || []).length;
    if (!firstReplayAt) firstReplayAt = now;
    lastReplayAt = now;
    console.log(`[probe] event_replay batch #${batchCount} +${now - t0}ms: ${(msg.events||[]).length} events; cumulative=${totalEventCount}; isLast=${msg.isLast}`);
    if (msg.isLast) {
      isLastSeen = true;
      console.log("");
      console.log("=== RESULTS ===");
      console.log(`total wall: ${now - t0}ms`);
      console.log(`time to WS-open: ${connectedAt - t0}ms`);
      console.log(`time to first replay batch: ${firstReplayAt - t0}ms`);
      console.log(`time to last replay batch: ${lastReplayAt - t0}ms`);
      console.log(`batches: ${batchCount}; events: ${totalEventCount}`);
      console.log(`replay-window only: ${lastReplayAt - firstReplayAt}ms`);
      console.log(`server throughput: ${(totalEventCount / ((lastReplayAt - firstReplayAt) || 1) * 1000).toFixed(0)} events/sec`);
      setTimeout(() => { ws.close(); process.exit(0); }, 200);
    }
  }
});

ws.on("error", (e) => { console.error("[probe] err:", e.message); process.exit(1); });
ws.on("close", () => {
  if (!isLastSeen) {
    console.log("");
    console.log("[probe] closed WITHOUT isLast — replay incomplete");
    console.log(`partial: ${batchCount} batches, ${totalEventCount} events in ${(lastReplayAt||Date.now()) - t0}ms`);
    process.exit(2);
  }
});

setTimeout(() => {
  console.error("[probe] timeout after 30s");
  process.exit(3);
}, 30000);
