// CC-r7 operator-dismiss (NEW, dl-13527) — the direct F1 live proof. An
// authenticated operator RENDERS (real ACK) then DISMISSES the prompt (a
// prompt_response with cancelled:true and NO answer). The browser gateway
// server-stamps the operator author on the dismiss (buildPromptResponseForward),
// the bridge → PromptBus.respond → deriveReceipt. The receipt MUST be
// dismissed:true, author={operator} PRESERVED (dl-13527 fix), renderedBy={operator},
// answered:false. Pre-fix the answerPresent gate DROPPED the dismisser author.
// Socket-proof zero :9999/:8000.
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");
const H = require("./lib.cjs");

const OUT = path.join(H.WS, "evidence", "operator-dismiss");
fs.mkdirSync(OUT, { recursive: true });
const TITLE = "Deploy Build-1 to production now?";
const OPTS = ["Deploy to production now", "Run one more validation pass first", "Cancel and hold"];
const STAGED = process.env.STAGED_HEAD || "worktree";

function readReceipt(tag) {
  const log = H.sessLog(tag); if (!log || !fs.existsSync(log)) return null;
  let found = null;
  const w = (o) => { if (o && typeof o === "object") { if (o.method === "select" && o.receipt) found = o; for (const v of Object.values(o)) w(v); } };
  for (const l of fs.readFileSync(log, "utf8").split("\n").filter(Boolean)) { try { w(JSON.parse(l)); } catch {} }
  return found;
}

(async () => {
  const result = { arm: "operator-dismiss-preserve (dl-13527)", staged_head: STAGED,
    config: { requireBrowserAuth: true, operatorUsers: ["operator"] } };
  const tag = "opdismiss-" + Date.now();
  const sid = await H.spawnSession(tag);
  result.session = sid;
  if (!sid) { result.error = "operator spawn failed"; fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result)); process.exit(1); }

  await H.driveAskSelect(sid, TITLE, "choose", OPTS);

  const opConn = await H.openWs(WebSocket, H.OP_COOKIE);
  result.ws_upgrade_allowed = opConn.ok;
  if (!opConn.ok) { result.error = "operator ws refused"; fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result)); process.exit(1); }
  const gotId = new Promise((res) => { opConn.ws.on("message", (b) => { let m; try { m = JSON.parse(b.toString()); } catch { return; } if (m.type === "prompt_request" && m.sessionId === sid) res(m.promptId); }); });
  opConn.ws.send(JSON.stringify({ type: "subscribe", sessionId: sid }));
  const promptId = await Promise.race([gotId, new Promise((r) => setTimeout(() => r(null), 45000))]);
  result.promptId = promptId;
  result.socket = H.socketProof("opdismiss", OUT);
  if (!promptId) { result.error = "no prompt_request"; fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result)); process.exit(1); }

  // Operator RENDERS (real ACK → renderedBy) then DISMISSES (cancelled:true, no answer).
  opConn.ws.send(JSON.stringify({ type: "prompt_rendered", sessionId: sid, promptId }));
  await H.sleep(500);
  opConn.ws.send(JSON.stringify({ type: "prompt_response", sessionId: sid, promptId, cancelled: true, source: "dashboard-default" }));
  await H.sleep(4000);

  const det = readReceipt(tag);
  result.details = det;
  const r = det ? det.receipt : null;
  result.receipt = r;
  result.assert_dismissed = !!(r && r.dismissed === true);
  result.assert_not_answered = !!(r && r.answered === false);
  // dl-13527: the authenticated DISMISSER identity is PRESERVED as receipt.author.
  result.assert_author_is_operator = !!(r && r.author && (r.author.username === "operator" || r.author.sub === "operator@op") && r.author.isOperator === true);
  result.assert_renderedBy_is_operator = !!(r && r.renderedBy && (r.renderedBy.username === "operator" || r.renderedBy.sub === "operator@op"));
  result.assert_zero_9999 = !result.socket.has9999;
  result.assert_zero_8000 = !result.socket.has8000;

  try { opConn.ws && opConn.ws.close(); } catch {}
  await H.shutdown(sid);

  result.PASS = [result.assert_dismissed, result.assert_not_answered, result.assert_author_is_operator, result.assert_renderedBy_is_operator, result.assert_zero_9999, result.assert_zero_8000].every(Boolean);
  fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.PASS ? 0 : 1);
})().catch((e) => { console.error("OPDISMISS_ERROR", e); process.exit(2); });
