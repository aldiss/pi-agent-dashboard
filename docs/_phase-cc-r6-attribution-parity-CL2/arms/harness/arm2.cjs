// CC-r6 Arm 2 (NEW identity) — A1 LIVE render-ACK proof on the staged CANDIDATE
// build (build1-picker-cand-attr @ NEW commit; 8s bus timeout). Multi-op mode so
// the render ACK carries a server-stamped operator author (renderedBy).
//
// Render is driven over the REAL /ws browser gateway via a raw `prompt_rendered`
// message (NOT a Playwright browser mount) so the arm runs without a chromium
// binary while still exercising the true bridge→PromptBus→deriveReceipt surface.
//
// Two sub-cases, contrasted:
//   (a) RENDERED-then-timeout: operator subscribes, server emits prompt_request,
//       operator sends prompt_rendered (real ACK, server-stamped author) — then
//       DOES NOT answer; the 8s PromptBus timeout fires. D1 receipt must be
//       delivered:true, rendered:true, timedOut:true, answered:false,
//       renderedBy=operator, and author ABSENT (nobody answered).
//   (b) NEVER-RENDERED: same ask, NO prompt_rendered sent — 8s timeout. Receipt
//       must be delivered:false, rendered:false, timedOut:true, no renderedBy,
//       no author.
// Socket-proof zero :9999/:8000 before each timeout.
const WebSocket = require("ws");
const jwt = require("jsonwebtoken");
const fs = require("fs");
const path = require("path");
const H = require("./lib.cjs");

const OUT = path.join(H.WS, "evidence", "arm2");
fs.mkdirSync(OUT, { recursive: true });
const WS_URL = "ws://127.0.0.1:8153/ws";
const TITLE = "Deploy Build-1 to production now?";
const MSG = "The candidate passed all pre-deploy gates. Choose how to proceed.";
const OPTS = ["Deploy to production now", "Run one more validation pass first", "Cancel and hold"];
const STAGED = process.env.STAGED_HEAD || "worktree";
const SECRET = process.env.C2_SECRET || "ccr6-multiop-secret-8153";
const OPERATOR = { sub: "operator@op", name: "Operator One", username: "operator", provider: "test" };
function mintToken(u) { return jwt.sign({ sub: u.sub, name: u.name, username: u.username, provider: u.provider }, SECRET, { expiresIn: "7d" }); }
function cookieFor(t) { return `pi_dash_token=${t}`; }

function readReceipt(tag) {
  const log = H.sessLog(tag);
  if (!log || !fs.existsSync(log)) return null;
  const lines = fs.readFileSync(log, "utf8").split("\n").filter(Boolean);
  let found = null;
  const w = (o) => { if (o && typeof o === "object") { if (o.method === "select" && o.receipt) found = o; for (const v of Object.values(o)) w(v); } };
  for (const l of lines) { try { w(JSON.parse(l)); } catch {} }
  return found;
}
function openWs(cookie) {
  return new Promise((resolve) => {
    const ws = new WebSocket(WS_URL, cookie ? { headers: { Cookie: cookie } } : {});
    let settled = false;
    ws.on("open", () => { if (!settled) { settled = true; resolve({ ok: true, ws }); } });
    ws.on("unexpected-response", (_q, res) => { if (!settled) { settled = true; resolve({ ok: false, code: res.statusCode, ws: null }); } });
    ws.on("error", (e) => { if (!settled) { settled = true; resolve({ ok: false, error: String(e), ws: null }); } });
  });
}
async function driveAsk(sid, cookie) {
  await apiCookie("POST", `/api/session/${sid}/prompt`, { text: `Call the ask_user tool exactly once, immediately, with NO other text. Use method="select", title="${TITLE}", message="${MSG}", options=["${OPTS[0]}","${OPTS[1]}","${OPTS[2]}"]. Just call the tool.` }, cookie);
}
// Multi-op spawn: /api/session/spawn is operator-gated, so post WITH the operator
// cookie (H.spawnSession in lib.cjs sends no cookie → 401 under multi-op).
const { execSync } = require("child_process");
const os = require("os");
function apiCookie(method, p, body, cookie) {
  return new Promise((resolve, reject) => {
    const http = require("http");
    const data = body ? JSON.stringify(body) : null;
    const headers = data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {};
    if (cookie) headers.Cookie = cookie;
    const req = http.request("http://127.0.0.1:8153" + p, { method, headers, timeout: 25000 }, (res) => {
      let buf = ""; res.on("data", (c) => (buf += c)); res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); } catch { resolve({ status: res.statusCode, body: buf }); } });
    });
    req.on("error", reject); req.on("timeout", () => req.destroy(new Error("timeout")));
    if (data) req.write(data); req.end();
  });
}
async function spawnAsOperator(tag, cookie) {
  const cwd = path.join(H.WS, "probe-cwds", tag);
  fs.mkdirSync(cwd, { recursive: true });
  await apiCookie("POST", "/api/session/spawn", { cwd, label: tag }, cookie);
  for (let t = 0; t < 30; t++) {
    await H.sleep(2000);
    const r = await apiCookie("GET", "/api/sessions", null, cookie);
    const rows = (r.body && r.body.data) || [];
    const s = rows.find((x) => String(x.cwd || "").includes(tag));
    if (s) { for (let u = 0; u < 12; u++) { if (H.sessLog(tag)) break; await H.sleep(2000); } return s.id; }
  }
  return null;
}
async function capturePromptId(ws, sid) {
  return new Promise((resolve) => {
    ws.on("message", (b) => { let m; try { m = JSON.parse(b.toString()); } catch { return; } if (m.type === "prompt_request" && m.sessionId === sid) resolve(m.promptId); });
    setTimeout(() => resolve(null), 45000);
  });
}

(async () => {
  const result = { arm: "A1-live-rendered-vs-never (D1 renderedBy split)", staged_head: STAGED };
  const opCookie = cookieFor(mintToken(OPERATOR));

  // ── (a) RENDERED-then-timeout via raw prompt_rendered ACK ──
  const tagA = "arm2-rendered";
  const sidA = await spawnAsOperator(tagA, opCookie);
  result.rendered = { session: sidA };
  if (sidA) {
    const conn = await openWs(opCookie);
    result.rendered.ws_upgrade_allowed = conn.ok;
    const idP = conn.ok ? capturePromptId(conn.ws, sidA) : Promise.resolve(null);
    if (conn.ok) conn.ws.send(JSON.stringify({ type: "subscribe", sessionId: sidA }));
    await H.sleep(300);
    await driveAsk(sidA, opCookie);
    const promptId = await idP;
    result.rendered.promptId = promptId;
    result.rendered.socket = H.socketProof("arm2-rendered", OUT);
    if (promptId && conn.ok) {
      // REAL render ACK over the gateway — server stamps operator author → renderedBy.
      conn.ws.send(JSON.stringify({ type: "prompt_rendered", sessionId: sidA, promptId }));
      await H.sleep(12000); // outlast 8s bus timeout WITHOUT answering
    }
    try { conn.ws && conn.ws.close(); } catch {}
    const det = readReceipt(tagA);
    result.rendered.details = det;
    const r = det ? det.receipt : null;
    result.rendered.receipt = r;
    result.rendered.assert_timedOut = !!(r && r.timedOut === true);
    result.rendered.assert_delivered_true = !!(r && r.delivered === true);
    result.rendered.assert_rendered_true = !!(r && r.rendered === true);
    result.rendered.assert_not_answered = !!(r && r.answered === false);
    // D1: renderedBy carries WHO rendered; author ABSENT (nobody answered).
    result.rendered.assert_renderedBy_operator = !!(r && r.renderedBy && (r.renderedBy.username === "operator" || r.renderedBy.sub === "operator@op"));
    result.rendered.assert_author_absent = !(r && r.author);
    try { await H.api("POST", `/api/session/${sidA}/shutdown`, {}); } catch {}
  }

  await H.sleep(1500);

  // ── (b) NEVER-RENDERED (no ACK) ──
  const tagB = "arm2-never";
  const sidB = await spawnAsOperator(tagB, opCookie);
  result.never = { session: sidB };
  if (sidB) {
    await driveAsk(sidB, opCookie);
    await H.sleep(2000);
    result.never.socket = H.socketProof("arm2-never", OUT);
    await H.sleep(12000);
    const det = readReceipt(tagB);
    result.never.details = det;
    const r = det ? det.receipt : null;
    result.never.receipt = r;
    result.never.assert_timedOut = !!(r && r.timedOut === true);
    result.never.assert_delivered_false = !!(r && r.delivered === false);
    result.never.assert_rendered_false = !!(r && r.rendered === false);
    result.never.assert_no_renderedBy = !(r && r.renderedBy);
    result.never.assert_no_author = !(r && r.author);
    try { await H.api("POST", `/api/session/${sidB}/shutdown`, {}); } catch {}
  }

  result.A1_LIVE_CONTRAST_PROVEN =
    !!(result.rendered.assert_delivered_true && result.rendered.assert_rendered_true &&
       result.rendered.assert_timedOut && result.rendered.assert_renderedBy_operator &&
       result.rendered.assert_author_absent &&
       result.never.assert_delivered_false && result.never.assert_rendered_false &&
       result.never.assert_timedOut && result.never.assert_no_renderedBy && result.never.assert_no_author);
  result.rendered_socket_clean = !!(result.rendered.socket && !result.rendered.socket.has9999 && !result.rendered.socket.has8000);
  result.never_socket_clean = !!(result.never.socket && !result.never.socket.has9999 && !result.never.socket.has8000);
  fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.A1_LIVE_CONTRAST_PROVEN ? 0 : 1);
})().catch((e) => { console.error("ARM2_ERROR", e); process.exit(2); });
