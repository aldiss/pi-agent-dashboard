// C2 harness — multi-operator JWT actual-surface auth arm on the isolated
// dashboard (multi-op config: requireBrowserAuth:true, operatorUsers:["operator"],
// secret). Mints real JWTs with the config secret, connects /ws with each
// principal's pi_dash_token cookie, and proves the operator-only gate:
//   operator → ACCEPTED (markRendered/respond proceed; receipt.author=operator)
//   guest    → DENIED at the gate (no mark/respond, no action)
//   no-cookie→ DENIED at the WS upgrade (connection refused)
const jwt = require("jsonwebtoken");
const WebSocket = require("ws");
const http = require("http");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const SECRET = "c2-multiop-test-secret-8153";
const BASE = "http://127.0.0.1:8153";
const WS_URL = "ws://127.0.0.1:8153/ws";
const WS = "/tmp/build1-p3c2-20260731-8153";
const OUT = path.join(WS, "evidence", "c2");
fs.mkdirSync(OUT, { recursive: true });
const SESS = path.join(WS, "state/.pi/agent/sessions");
const DASH_LOG = path.join(WS, "evidence", "dash.log");

const TITLE = "Deploy Build-1 to production now?";
const OPTS = ["Deploy to production now", "Run one more validation pass first", "Cancel and hold"];

// Mint a JWT the server will verify (same secret + payload shape as signToken).
function mintToken(user) {
  return jwt.sign({ sub: user.sub, name: user.name, username: user.username, provider: user.provider }, SECRET, { expiresIn: "7d" });
}
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
  const pids = execSync(`pgrep -f "build1-p3c2-20260731-8153" || true`, { encoding: "utf8" }).split(/\s+/).filter(Boolean);
  for (const p of pids) { const o = execSync(`lsof -nP -a -p ${p} -iTCP 2>/dev/null || true`, { encoding: "utf8" }); out += `--- pid ${p} ---\n${o.trim() || "(no TCP)"}\n`; }
  const has9999 = /:9999\b/.test(out), has8000 = /:8000\b/.test(out);
  fs.writeFileSync(path.join(OUT, `${tag}-socket-proof.txt`), `ts=${new Date().toISOString()}\nhas9999=${has9999} has8000=${has8000}\n\n${out}`);
  return { has9999, has8000 };
}
function cookieFor(token) { return `pi_dash_token=${token}`; }

// Open a WS with a cookie; resolve {ok, code} — ok:false when the upgrade is refused.
function openWs(cookie) {
  return new Promise((resolve) => {
    const headers = cookie ? { Cookie: cookie } : {};
    const ws = new WebSocket(WS_URL, { headers });
    let settled = false;
    ws.on("open", () => { if (!settled) { settled = true; resolve({ ok: true, ws }); } });
    ws.on("unexpected-response", (_req, res) => { if (!settled) { settled = true; resolve({ ok: false, code: res.statusCode, ws: null }); } });
    ws.on("error", (e) => { if (!settled) { settled = true; resolve({ ok: false, error: String(e), ws: null }); } });
  });
}

// Count "refused by auth gate" lines in dash.log for a given type.
function gateRefusalsFor(type, sinceMark) {
  const txt = fs.existsSync(DASH_LOG) ? fs.readFileSync(DASH_LOG, "utf8") : "";
  const tail = sinceMark != null ? txt.slice(sinceMark) : txt;
  const lines = tail.split("\n").filter((l) => /refused by auth gate/.test(l) && l.includes(type));
  return lines;
}
function dashLogLen() { return fs.existsSync(DASH_LOG) ? fs.statSync(DASH_LOG).size : 0; }

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
  const result = { arm: "C2-multiop-jwt-live-auth", staged_head: process.env.STAGED_HEAD || "worktree",
    config: { requireBrowserAuth: true, operatorUsers: ["operator"] } };
  const opCookie = cookieFor(mintToken(OPERATOR));
  const guestCookie = cookieFor(mintToken(GUEST));

  // ── no-principal: WS upgrade REFUSED in multi-op mode ──
  const noPrin = await openWs(undefined);
  result.no_principal = { ws_upgrade_allowed: noPrin.ok, upgrade_status: noPrin.code };
  result.no_principal.assert_denied = noPrin.ok === false;
  if (noPrin.ws) try { noPrin.ws.close(); } catch {}

  // ── guest: WS upgrade allowed (valid cookie) but the message gate DENIES ──
  const guestConn = await openWs(guestCookie);
  result.guest = { ws_upgrade_allowed: guestConn.ok };

  // Spawn a session AS OPERATOR (needs operator to create).
  const tag = "c2-session-" + Date.now();
  const sid = await spawnAsOperator(tag, opCookie);
  result.session = sid;
  if (!sid) { result.error = "operator spawn failed"; fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result)); process.exit(1); }

  // Operator drives the ask.
  await api("POST", `/api/session/${sid}/prompt`, { text: `Call ask_user once, immediately, NO other text. method="select", title="${TITLE}", message="choose", options=["${OPTS[0]}","${OPTS[1]}","${OPTS[2]}"]. Just call the tool.` }, opCookie);

  // Capture the promptId via an OPERATOR ws subscription.
  const opConn = await openWs(opCookie);
  result.operator = { ws_upgrade_allowed: opConn.ok };
  let promptId = null;
  const gotId = new Promise((res) => { opConn.ws.on("message", (b) => { let m; try { m = JSON.parse(b.toString()); } catch { return; } if (m.type === "prompt_request" && m.sessionId === sid) res(m.promptId); }); });
  opConn.ws.send(JSON.stringify({ type: "subscribe", sessionId: sid }));
  promptId = await Promise.race([gotId, new Promise((r) => setTimeout(() => r(null), 45000))]);
  result.promptId = promptId;
  result.socket = socketProof("c2");
  if (!promptId) { result.error = "no prompt_request"; fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result)); process.exit(1); }

  // ── GUEST attempts prompt_rendered + prompt_response FIRST, with a DISTINCT
  //    forged answer. If the gate had ALLOWED the guest, PromptBus
  //    first-response-wins would record the guest's value + no operator author.
  //    Because the guest is DENIED, the guest's message is dropped and the later
  //    OPERATOR answer wins → deterministic behavioral proof (no log-grep, which
  //    is unreliable here because the server buffers stderr). ──
  const GUEST_FORGED = "GUEST-FORGED-ANSWER-Cancel and hold";
  const mark1 = dashLogLen();
  if (guestConn.ok) {
    guestConn.ws.send(JSON.stringify({ type: "subscribe", sessionId: sid }));
    await sleep(300);
    guestConn.ws.send(JSON.stringify({ type: "prompt_rendered", sessionId: sid, promptId }));
    guestConn.ws.send(JSON.stringify({ type: "prompt_response", sessionId: sid, promptId, answer: GUEST_FORGED, cancelled: false, source: "dashboard-default" }));
    await sleep(2500);
  }
  result.guest.forged_answer = GUEST_FORGED;
  result.guest.gate_refusals = gateRefusalsFor("prompt_", mark1).slice(0, 6);
  // The receipt must NOT have resolved to the guest's forged answer (proof the
  // guest's prompt_response was denied — it did NOT win first-response).
  const afterGuest = readReceipt(tag);
  result.guest.receipt_after_guest = afterGuest ? afterGuest.receipt : null;
  result.guest.result_after_guest = afterGuest ? afterGuest.result : null;
  result.guest.assert_guest_answer_did_not_win = !(afterGuest && afterGuest.result === GUEST_FORGED);
  result.guest.assert_no_guest_answer = !(afterGuest && afterGuest.receipt && afterGuest.receipt.answered === true);

  // ── OPERATOR renders + answers with a DISTINCT value → ACCEPTED, receipt is
  //    the OPERATOR's value + receipt.author = operator (proves the guest's
  //    earlier forged answer never won). ──
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
  result.operator.assert_author_is_operator = !!(r && r.author && (r.author.username === "operator" || r.author.sub === "operator@op") && r.author.isOperator === true);

  try { guestConn.ws && guestConn.ws.close(); } catch {}
  try { opConn.ws && opConn.ws.close(); } catch {}
  try { await api("POST", `/api/session/${sid}/shutdown`, {}, opCookie); } catch {}

  result.assert_zero_9999 = !result.socket.has9999;
  result.assert_zero_8000 = !result.socket.has8000;
  result.C2_PROVEN = [
    result.no_principal.assert_denied,             // no-cookie → WS upgrade 401
    result.guest.assert_guest_answer_did_not_win,  // guest forged answer NEVER won (denied)
    result.guest.assert_no_guest_answer,           // prompt not resolved by the guest
    result.operator.assert_answered,               // operator answer accepted
    result.operator.assert_result_is_operator_value, // receipt = operator's DISTINCT value
    result.operator.assert_author_is_operator,     // receipt.author = the operator
    result.assert_zero_9999, result.assert_zero_8000,
  ].every(Boolean);
  fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.C2_PROVEN ? 0 : 1);
})().catch((e) => { console.error("C2_ERROR", e); process.exit(2); });
