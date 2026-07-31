// CC-r7 arm3 — malformed response → invalid non-decision on the staged CANDIDATE
// build (7fc75b5). Multi-op: the operator's /ws injects a malformed prompt_response
// (cancelled:false, NO answer field). The server gate accepts the operator, the
// bridge → PromptBus.respond → stash → deriveReceipt → invalid. Asserts
// receipt.invalid=true, answered=false, JSONL has NO "User responded: undefined",
// D1 no author leak on a malformed non-answer. Socket-proof zero :9999/:8000.
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");
const H = require("./lib.cjs");

const OUT = path.join(H.WS, "evidence", "arm3");
fs.mkdirSync(OUT, { recursive: true });
const TITLE = "Deploy Build-1 to production now?";
const MSG = "The candidate passed all pre-deploy gates. Choose how to proceed.";
const OPTS = ["Deploy to production now", "Run one more validation pass first", "Cancel and hold"];
const STAGED = process.env.STAGED_HEAD || "worktree";

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
  const result = { arm: "malformed-invalid-nondecision", staged_head: STAGED };
  const tag = "arm3-malformed-" + Date.now();
  const sid = await H.spawnSession(tag);
  result.session = sid;
  if (!sid) { result.error = "spawn failed"; fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result)); process.exit(1); }

  const conn = await H.openWs(WebSocket, H.OP_COOKIE);
  result.ws_upgrade_allowed = conn.ok;
  if (!conn.ok) { result.error = "operator ws upgrade refused"; fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result)); process.exit(1); }
  const ws = conn.ws;
  const gotPromptId = new Promise((resolve) => {
    ws.on("message", (buf) => { let m; try { m = JSON.parse(buf.toString()); } catch { return; } if (m.type === "prompt_request" && m.sessionId === sid) resolve(m.promptId); });
  });
  ws.send(JSON.stringify({ type: "subscribe", sessionId: sid }));
  await H.sleep(500);

  await H.driveAskSelect(sid, TITLE, MSG, OPTS);

  const promptId = await Promise.race([gotPromptId, new Promise((r) => setTimeout(() => r(null), 90000))]);
  result.promptId = promptId;
  result.socket = H.socketProof(tag, OUT);
  if (!promptId) { result.error = "no prompt_request seen"; fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result)); try { ws.close(); } catch {} process.exit(1); }

  // INJECT the malformed response: cancelled:false, NO answer field.
  ws.send(JSON.stringify({ type: "prompt_response", sessionId: sid, promptId, cancelled: false, source: "dashboard-default" }));
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
  // dl-13527: `author` = the RESPONDER actor. The operator submitted this
  // (malformed) response over an authenticated /ws, so the gateway server-stamps
  // the operator author — legitimately preserved even though the payload is
  // `invalid`. The invariant is NOT "no author" (that was a pre-F1 assumption);
  // it is that a malformed response NEVER reads as an ANSWER and, if authored,
  // the author is the operator responder (never a false answerer).
  result.assert_author_is_operator_responder = !(r && r.author) || !!(r.author && (r.author.username === "operator" || r.author.sub === "operator@op"));
  result.assert_invalid_not_answered = !!(r && r.invalid === true && r.answered === false);
  result.assert_zero_9999 = !result.socket.has9999;
  result.assert_zero_8000 = !result.socket.has8000;
  result.PASS = [result.assert_invalid, result.assert_not_answered, result.assert_no_undefined_decision, result.assert_author_is_operator_responder, result.assert_invalid_not_answered, result.assert_zero_9999, result.assert_zero_8000].every(Boolean);
  fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  await H.shutdown(sid);
  process.exit(result.PASS ? 0 : 1);
})().catch((e) => { console.error("ARM3_ERROR", e); process.exit(2); });
