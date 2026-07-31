// Arm 3 — malformed response → invalid non-decision, on the staged 2e8df4c
// build. Injects a LIVE malformed prompt_response over the real /ws browser
// gateway: {cancelled:false} with NO answer field. Single-operator mode (temp
// HOME has no operatorUsers) → the B2 gate no-ops → the malformed message
// reaches the bridge → PromptBus.respond → stash → deriveReceipt → invalid.
// Asserts: receipt.invalid=true, answered=false, and the JSONL NEVER contains
// "User responded: undefined". Socket-proof zero :9999/:8000.
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");
const H = require("./lib.cjs");

const OUT = path.join(H.WS, "evidence", "arm3");
fs.mkdirSync(OUT, { recursive: true });
const WS_URL = "ws://127.0.0.1:8153/ws";
const TITLE = "Deploy Build-1 to production now?";
const MSG = "The candidate passed all pre-deploy gates. Choose how to proceed.";
const OPTS = ["Deploy to production now", "Run one more validation pass first", "Cancel and hold"];

function readReceipt(tag) {
  const log = H.sessLog(tag);
  if (!log || !fs.existsSync(log)) return null;
  const lines = fs.readFileSync(log, "utf8").split("\n").filter(Boolean);
  let found = null;
  const w = (o) => { if (o && typeof o === "object") { if (o.method === "select" && o.receipt) found = o; for (const v of Object.values(o)) w(v); } };
  for (const l of lines) { try { w(JSON.parse(l)); } catch {} }
  return found;
}

(async () => {
  const result = { arm: "malformed-invalid-nondecision", staged: "2e8df4c" };
  const tag = "arm3-malformed";
  const sid = await H.spawnSession(tag);
  result.session = sid;
  if (!sid) { result.error = "spawn failed"; fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result)); process.exit(1); }

  // Open the real browser WS, subscribe, capture the prompt_request promptId.
  const ws = new WebSocket(WS_URL);
  const gotPromptId = new Promise((resolve) => {
    ws.on("message", (buf) => {
      let m; try { m = JSON.parse(buf.toString()); } catch { return; }
      if (m.type === "prompt_request" && m.sessionId === sid) resolve(m.promptId);
    });
  });
  await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
  ws.send(JSON.stringify({ type: "subscribe", sessionId: sid }));
  await H.sleep(500);

  // Drive the ask.
  await H.api("POST", `/api/session/${sid}/prompt`, { text: `Call the ask_user tool exactly once, immediately, with NO other text. Use method="select", title="${TITLE}", message="${MSG}", options=["${OPTS[0]}","${OPTS[1]}","${OPTS[2]}"]. Just call the tool.` });

  // Wait for the prompt_request (carries promptId), with a cap.
  const promptId = await Promise.race([gotPromptId, new Promise((r) => setTimeout(() => r(null), 45000))]);
  result.promptId = promptId;
  result.socket = H.socketProof(tag, OUT);

  if (!promptId) { result.error = "no prompt_request seen"; fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result)); try { ws.close(); } catch {} process.exit(1); }

  // INJECT the malformed response: cancelled:false, NO answer field.
  ws.send(JSON.stringify({ type: "prompt_response", sessionId: sid, promptId, cancelled: false, source: "dashboard-default" }));
  // (answer intentionally OMITTED → malformed → invalid)
  await H.sleep(6000);
  try { ws.close(); } catch {}

  const det = readReceipt(tag);
  result.details = det;
  const r = det ? det.receipt : null;
  result.receipt = r;
  result.jsonl_has_undefined_decision = H.jsonlHasUndefinedDecision(tag);
  result.assert_invalid = !!(r && r.invalid === true);
  result.assert_not_answered = !!(r && r.answered === false);
  result.assert_no_undefined_decision = result.jsonl_has_undefined_decision === false;
  result.assert_zero_9999 = !result.socket.has9999;
  result.assert_zero_8000 = !result.socket.has8000;
  result.PASS = [result.assert_invalid, result.assert_not_answered, result.assert_no_undefined_decision, result.assert_zero_9999, result.assert_zero_8000].every(Boolean);
  fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  try { await H.api("POST", `/api/session/${sid}/shutdown`, {}); } catch {}
  process.exit(result.PASS ? 0 : 1);
})().catch((e) => { console.error("ARM3_ERROR", e); process.exit(2); });
