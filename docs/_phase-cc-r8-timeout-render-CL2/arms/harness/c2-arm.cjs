// CC-r7 C2 — multi-operator JWT actual-surface auth arm on the staged CANDIDATE
// build (7fc75b5). Config requireBrowserAuth:true, operatorUsers:["operator"].
// Proves the operator-only gate:
//   no-cookie → WS upgrade 401; guest forged answer never wins; operator answer →
//   receipt.author={operator} (the ANSWERER) + receipt.renderedBy={operator}
//   (the RENDERER) — dl-13383 split intact. Socket-proof zero :9999/:8000.
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");
const H = require("./lib.cjs");

const OUT = path.join(H.WS, "evidence", "c2");
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
  const result = { arm: "C2-multiop-jwt-live-auth (dl-13383 split intact)", staged_head: STAGED,
    config: { requireBrowserAuth: true, operatorUsers: ["operator"] } };

  const noPrin = await H.openWs(WebSocket, undefined);
  result.no_principal = { ws_upgrade_allowed: noPrin.ok, upgrade_status: noPrin.code, assert_denied: noPrin.ok === false };
  if (noPrin.ws) try { noPrin.ws.close(); } catch {}

  const guestConn = await H.openWs(WebSocket, H.GUEST_COOKIE);
  result.guest = { ws_upgrade_allowed: guestConn.ok };

  const tag = "c2-session-" + Date.now();
  const sid = await H.spawnSession(tag);
  result.session = sid;
  if (!sid) { result.error = "operator spawn failed"; fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result)); process.exit(1); }

  await H.driveAskSelect(sid, TITLE, "choose", OPTS);

  const opConn = await H.openWs(WebSocket, H.OP_COOKIE);
  result.operator = { ws_upgrade_allowed: opConn.ok };
  const gotId = new Promise((res) => { opConn.ws.on("message", (b) => { let m; try { m = JSON.parse(b.toString()); } catch { return; } if (m.type === "prompt_request" && m.sessionId === sid) res(m.promptId); }); });
  opConn.ws.send(JSON.stringify({ type: "subscribe", sessionId: sid }));
  const promptId = await Promise.race([gotId, new Promise((r) => setTimeout(() => r(null), 45000))]);
  result.promptId = promptId;
  result.socket = H.socketProof("c2", OUT);
  if (!promptId) { result.error = "no prompt_request"; fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result)); process.exit(1); }

  // GUEST forged render+answer FIRST — must be dropped by the gate.
  const GUEST_FORGED = "GUEST-FORGED-ANSWER-Cancel and hold";
  if (guestConn.ok) {
    guestConn.ws.send(JSON.stringify({ type: "subscribe", sessionId: sid }));
    await H.sleep(300);
    guestConn.ws.send(JSON.stringify({ type: "prompt_rendered", sessionId: sid, promptId }));
    guestConn.ws.send(JSON.stringify({ type: "prompt_response", sessionId: sid, promptId, answer: GUEST_FORGED, cancelled: false, source: "dashboard-default" }));
    await H.sleep(2500);
  }
  result.guest.forged_answer = GUEST_FORGED;
  const afterGuest = readReceipt(tag);
  result.guest.result_after_guest = afterGuest ? afterGuest.result : null;
  result.guest.assert_guest_answer_did_not_win = !(afterGuest && afterGuest.result === GUEST_FORGED);
  result.guest.assert_no_guest_answer = !(afterGuest && afterGuest.receipt && afterGuest.receipt.answered === true);

  // OPERATOR renders + answers with a DISTINCT value → ACCEPTED.
  const OPERATOR_ANSWER = "Run one more validation pass first";
  opConn.ws.send(JSON.stringify({ type: "prompt_rendered", sessionId: sid, promptId }));
  await H.sleep(500);
  opConn.ws.send(JSON.stringify({ type: "prompt_response", sessionId: sid, promptId, answer: OPERATOR_ANSWER, cancelled: false, source: "dashboard-default" }));
  await H.sleep(4000);
  const det = readReceipt(tag);
  result.operator.details = det;
  const r = det ? det.receipt : null;
  result.operator.receipt = r;
  result.operator.result = det ? det.result : null;
  result.operator.assert_answered = !!(r && r.answered === true);
  result.operator.assert_result_is_operator_value = det ? det.result === OPERATOR_ANSWER : false;
  result.operator.assert_author_is_operator = !!(r && r.author && (r.author.username === "operator" || r.author.sub === "operator@op") && r.author.isOperator === true);
  result.operator.assert_renderedBy_is_operator = !!(r && r.renderedBy && (r.renderedBy.username === "operator" || r.renderedBy.sub === "operator@op"));

  try { guestConn.ws && guestConn.ws.close(); } catch {}
  try { opConn.ws && opConn.ws.close(); } catch {}
  await H.shutdown(sid);

  result.assert_zero_9999 = !result.socket.has9999;
  result.assert_zero_8000 = !result.socket.has8000;
  result.C2_PROVEN = [
    result.no_principal.assert_denied,
    result.guest.assert_guest_answer_did_not_win,
    result.guest.assert_no_guest_answer,
    result.operator.assert_answered,
    result.operator.assert_result_is_operator_value,
    result.operator.assert_author_is_operator,
    result.operator.assert_renderedBy_is_operator,
    result.assert_zero_9999, result.assert_zero_8000,
  ].every(Boolean);
  fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.C2_PROVEN ? 0 : 1);
})().catch((e) => { console.error("C2_ERROR", e); process.exit(2); });
