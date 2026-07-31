// CC-r6 C2 (NEW identity) — multi-operator JWT actual-surface auth arm on the
// staged CANDIDATE dashboard (build1-picker-cand-attr @ NEW commit). Config:
// requireBrowserAuth:true, operatorUsers:["operator"], secret. Mints real JWTs,
// connects /ws with each principal's pi_dash_token cookie, proves the
// operator-only gate:
//   operator → ACCEPTED (markRendered/respond proceed; receipt.author=operator)
//   guest    → DENIED at the message gate (forged answer never wins)
//   no-cookie→ DENIED at the WS upgrade (401)
// D1: the operator RENDERS then ANSWERS → receipt.author=operator (the ANSWERER)
// AND receipt.renderedBy=operator (the RENDERER) — split fields, both the operator
// here. Socket-proof zero :9999/:8000.
const jwt = require("jsonwebtoken");
const WebSocket = require("ws");
const http = require("http");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const SECRET = process.env.C2_SECRET || "ccr6-multiop-secret-8153";
const BASE = "http://127.0.0.1:8153";
const WS_URL = "ws://127.0.0.1:8153/ws";
const WS = "/tmp/build1-ccr6-cand-8153";
const MARKER = "build1-ccr6-cand-8153";
const OUT = path.join(WS, "evidence", "c2");
fs.mkdirSync(OUT, { recursive: true });
const SESS = path.join(WS, "state/.pi/agent/sessions");
const STAGED = process.env.STAGED_HEAD || "worktree";

const TITLE = "Deploy Build-1 to production now?";
const OPTS = ["Deploy to production now", "Run one more validation pass first", "Cancel and hold"];

function mintToken(u) { return jwt.sign({ sub: u.sub, name: u.name, username: u.username, provider: u.provider }, SECRET, { expiresIn: "7d" }); }
const OPERATOR = { sub: "operator@op", name: "Operator One", username: "operator", provider: "test" };
const GUEST = { sub: "guest@g", name: "Guest Viewer", username: "guest", provider: "test" };

function api(method, p, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {};
    if (cookie) headers.Cookie = cookie;
    const req = http.request(BASE + p, { method, headers, timeout: 25000 }, (res) => {
      let buf = ""; res.on("data", (c) => (buf += c)); res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); } catch { resolve({ status: res.statusCode, body: buf }); } });
    });
    req.on("error", reject); req.on("timeout", () => req.destroy(new Error("timeout")));
    if (data) req.write(data); req.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function sessDir(tag) { const h = execSync(`find "${SESS}" -maxdepth 1 -type d -path '*${tag}*' 2>/dev/null || true`, { encoding: "utf8" }).split("\n").filter(Boolean); return h[0] || null; }
function sessLog(tag) { const d = sessDir(tag); if (!d) return null; const h = execSync(`find "${d}" -name '*.jsonl' 2>/dev/null || true`, { encoding: "utf8" }).split("\n").filter(Boolean); return h[0] || null; }
function readReceipt(tag) {
  const log = sessLog(tag); if (!log || !fs.existsSync(log)) return null;
  let found = null;
  const w = (o) => { if (o && typeof o === "object") { if (o.method === "select" && o.receipt) found = o; for (const v of Object.values(o)) w(v); } };
  for (const l of fs.readFileSync(log, "utf8").split("\n").filter(Boolean)) { try { w(JSON.parse(l)); } catch {} }
  return found;
}
function socketProof(tag) {
  let out = "";
  const pids = execSync(`pgrep -f "${MARKER}" || true`, { encoding: "utf8" }).split(/\s+/).filter(Boolean);
  for (const p of pids) { const o = execSync(`lsof -nP -a -p ${p} -iTCP 2>/dev/null || true`, { encoding: "utf8" }); out += `--- pid ${p} ---\n${o.trim() || "(no TCP)"}\n`; }
  const has9999 = /:9999\b/.test(out), has8000 = /:8000\b/.test(out);
  fs.writeFileSync(path.join(OUT, `${tag}-socket-proof.txt`), `ts=${new Date().toISOString()}\nhas9999=${has9999} has8000=${has8000}\n\n${out}`);
  return { has9999, has8000 };
}
function cookieFor(token) { return `pi_dash_token=${token}`; }
function openWs(cookie) {
  return new Promise((resolve) => {
    const ws = new WebSocket(WS_URL, cookie ? { headers: { Cookie: cookie } } : {});
    let settled = false;
    ws.on("open", () => { if (!settled) { settled = true; resolve({ ok: true, ws }); } });
    ws.on("unexpected-response", (_q, res) => { if (!settled) { settled = true; resolve({ ok: false, code: res.statusCode, ws: null }); } });
    ws.on("error", (e) => { if (!settled) { settled = true; resolve({ ok: false, error: String(e), ws: null }); } });
  });
}
async function spawnAsOperator(tag, opCookie) {
  const cwd = path.join(WS, "probe-cwds", tag);
  fs.mkdirSync(cwd, { recursive: true });
  await api("POST", "/api/session/spawn", { cwd, label: tag }, opCookie);
  for (let t = 0; t < 30; t++) {
    await sleep(2000);
    const r = await api("GET", "/api/sessions", null, opCookie);
    const rows = (r.body && r.body.data) || [];
    const s = rows.find((x) => String(x.cwd || "").includes(tag));
    if (s) { for (let u = 0; u < 12; u++) { if (sessLog(tag)) break; await sleep(2000); } return s.id; }
  }
  return null;
}

(async () => {
  const result = { arm: "C2-multiop-jwt-live-auth (D1 author/renderedBy split)", staged_head: STAGED,
    config: { requireBrowserAuth: true, operatorUsers: ["operator"] } };
  const opCookie = cookieFor(mintToken(OPERATOR));
  const guestCookie = cookieFor(mintToken(GUEST));

  const noPrin = await openWs(undefined);
  result.no_principal = { ws_upgrade_allowed: noPrin.ok, upgrade_status: noPrin.code, assert_denied: noPrin.ok === false };
  if (noPrin.ws) try { noPrin.ws.close(); } catch {}

  const guestConn = await openWs(guestCookie);
  result.guest = { ws_upgrade_allowed: guestConn.ok };

  const tag = "c2-session-" + Date.now();
  const sid = await spawnAsOperator(tag, opCookie);
  result.session = sid;
  if (!sid) { result.error = "operator spawn failed"; fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result)); process.exit(1); }

  await api("POST", `/api/session/${sid}/prompt`, { text: `Call ask_user once, immediately, NO other text. method="select", title="${TITLE}", message="choose", options=["${OPTS[0]}","${OPTS[1]}","${OPTS[2]}"]. Just call the tool.` }, opCookie);

  const opConn = await openWs(opCookie);
  result.operator = { ws_upgrade_allowed: opConn.ok };
  const gotId = new Promise((res) => { opConn.ws.on("message", (b) => { let m; try { m = JSON.parse(b.toString()); } catch { return; } if (m.type === "prompt_request" && m.sessionId === sid) res(m.promptId); }); });
  opConn.ws.send(JSON.stringify({ type: "subscribe", sessionId: sid }));
  const promptId = await Promise.race([gotId, new Promise((r) => setTimeout(() => r(null), 45000))]);
  result.promptId = promptId;
  result.socket = socketProof("c2");
  if (!promptId) { result.error = "no prompt_request"; fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result)); process.exit(1); }

  // GUEST forged render+answer FIRST — must be dropped by the gate.
  const GUEST_FORGED = "GUEST-FORGED-ANSWER-Cancel and hold";
  if (guestConn.ok) {
    guestConn.ws.send(JSON.stringify({ type: "subscribe", sessionId: sid }));
    await sleep(300);
    guestConn.ws.send(JSON.stringify({ type: "prompt_rendered", sessionId: sid, promptId }));
    guestConn.ws.send(JSON.stringify({ type: "prompt_response", sessionId: sid, promptId, answer: GUEST_FORGED, cancelled: false, source: "dashboard-default" }));
    await sleep(2500);
  }
  result.guest.forged_answer = GUEST_FORGED;
  const afterGuest = readReceipt(tag);
  result.guest.result_after_guest = afterGuest ? afterGuest.result : null;
  result.guest.assert_guest_answer_did_not_win = !(afterGuest && afterGuest.result === GUEST_FORGED);
  result.guest.assert_no_guest_answer = !(afterGuest && afterGuest.receipt && afterGuest.receipt.answered === true);

  // OPERATOR renders + answers with a DISTINCT value → ACCEPTED.
  const OPERATOR_ANSWER = "Run one more validation pass first";
  opConn.ws.send(JSON.stringify({ type: "prompt_rendered", sessionId: sid, promptId }));
  await sleep(500);
  opConn.ws.send(JSON.stringify({ type: "prompt_response", sessionId: sid, promptId, answer: OPERATOR_ANSWER, cancelled: false, source: "dashboard-default" }));
  await sleep(4000);
  const det = readReceipt(tag);
  result.operator.details = det;
  const r = det ? det.receipt : null;
  result.operator.receipt = r;
  result.operator.result = det ? det.result : null;
  result.operator.assert_answered = !!(r && r.answered === true);
  result.operator.assert_result_is_operator_value = det ? det.result === OPERATOR_ANSWER : false;
  // D1: author = the ANSWERER (operator); renderedBy = the RENDERER (operator). Both split, both present.
  result.operator.assert_author_is_operator = !!(r && r.author && (r.author.username === "operator" || r.author.sub === "operator@op") && r.author.isOperator === true);
  result.operator.assert_renderedBy_is_operator = !!(r && r.renderedBy && (r.renderedBy.username === "operator" || r.renderedBy.sub === "operator@op"));

  try { guestConn.ws && guestConn.ws.close(); } catch {}
  try { opConn.ws && opConn.ws.close(); } catch {}
  try { await api("POST", `/api/session/${sid}/shutdown`, {}, opCookie); } catch {}

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
