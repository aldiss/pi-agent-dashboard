// CC-r7 NEW-IDENTITY shared harness lib. Isolated loopback 8155/8156, staged
// CANDIDATE build (build1-picker-cand-attr @ NEW commit 7fc75b5). MULTI-OP:
// /api/session/spawn + /prompt + actions are operator-gated → every call carries
// the operator JWT cookie. Loopback-only; every arm socket-proves zero :9999/:8000.
// Real-DOM: launchBrowser resolves the ms-playwright chromium (chromium-1217).
const http = require("http");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");

const BASE = "http://127.0.0.1:8155";
const WS_URL = "ws://127.0.0.1:8155/ws";
const WS = "/tmp/build1-ccr7-cand-8155";
const MARKER = "build1-ccr7-cand-8155";
const SESS = path.join(WS, "state/.pi/agent/sessions");
const SECRET = process.env.C2_SECRET || "ccr7-multiop-secret-8155";
const OPERATOR = { sub: "operator@op", name: "Operator One", username: "operator", provider: "test" };
const GUEST = { sub: "guest@g", name: "Guest Viewer", username: "guest", provider: "test" };
function mintToken(u) { return jwt.sign({ sub: u.sub, name: u.name, username: u.username, provider: u.provider }, SECRET, { expiresIn: "7d" }); }
function cookieFor(t) { return `pi_dash_token=${t}`; }
const OP_COOKIE = cookieFor(mintToken(OPERATOR));
const GUEST_COOKIE = cookieFor(mintToken(GUEST));

// Full chromium (with the headed app bundle) for real-DOM mount + screenshot.
function findChromium() {
  const base = path.join(process.env.HOME || "", "Library/Caches/ms-playwright");
  try {
    // prefer the full chromium build (has Google Chrome for Testing.app) over headless-shell
    const dirs = fs.readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort();
    for (const d of dirs.reverse()) {
      const p = path.join(base, d, "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents/MacOS/Google Chrome for Testing");
      if (fs.existsSync(p)) return p;
    }
  } catch {}
  return null;
}

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

// Operator-gated spawn: POST with the operator cookie, poll /api/sessions (cookie) until the session + its jsonl exist.
async function spawnSession(tag) {
  const cwd = path.join(WS, "probe-cwds", tag);
  fs.mkdirSync(cwd, { recursive: true });
  await api("POST", "/api/session/spawn", { cwd, label: tag }, OP_COOKIE);
  for (let t = 0; t < 30; t++) {
    await sleep(2000);
    const r = await api("GET", "/api/sessions", null, OP_COOKIE);
    const rows = (r.body && r.body.data) || [];
    const s = rows.find((x) => String(x.cwd || "").includes(tag));
    if (s) { for (let u = 0; u < 12; u++) { if (sessLog(tag)) break; await sleep(2000); } return s.id; }
  }
  return null;
}
async function driveAskSelect(sid, title, message, options) {
  await api("POST", `/api/session/${sid}/prompt`, { text: `Call the ask_user tool exactly once, immediately, with NO other text. Use method="select", title="${title}", message="${message}", options=[${options.map((o) => `"${o}"`).join(",")}]. Just call the tool.` }, OP_COOKIE);
}
async function shutdown(sid) { try { await api("POST", `/api/session/${sid}/shutdown`, {}, OP_COOKIE); } catch {} }

function socketProof(tag, outDir) {
  let out = "";
  const pids = execSync(`pgrep -f "${MARKER}" || true`, { encoding: "utf8" }).split(/\s+/).filter(Boolean);
  for (const p of pids) { const o = execSync(`lsof -nP -a -p ${p} -iTCP 2>/dev/null || true`, { encoding: "utf8" }); out += `--- pid ${p} ---\n${o.trim() || "(no TCP)"}\n`; }
  const has9999 = /:9999\b/.test(out), has8000 = /:8000\b/.test(out);
  const nonLoop = out.split("\n").filter((l) => /\b(LISTEN|ESTABLISHED)\b/.test(l) && !/127\.0\.0\.1|\[::1\]/.test(l));
  fs.writeFileSync(path.join(outDir, `${tag}-socket-proof.txt`), `ts=${new Date().toISOString()}\nhas9999=${has9999} has8000=${has8000}\nnon_loopback=${nonLoop.length}\n\n${out}`);
  return { has9999, has8000, nonLoop: nonLoop.length };
}

function readDetails(tag, method) {
  const log = sessLog(tag);
  if (!log || !fs.existsSync(log)) return null;
  const lines = fs.readFileSync(log, "utf8").split("\n").filter(Boolean);
  let found = null;
  const wants = method || null;
  const w = (o) => { if (o && typeof o === "object") { if (o.receipt && o.method && (!wants || o.method === wants)) found = o; for (const v of Object.values(o)) w(v); } };
  for (const l of lines) { try { w(JSON.parse(l)); } catch {} }
  return found;
}
function jsonlHasUndefinedDecision(tag) { const log = sessLog(tag); if (!log) return false; return /User responded:\s*undefined/.test(fs.readFileSync(log, "utf8")); }

function launchBrowser(playwright) {
  const exec = findChromium();
  if (!exec) throw new Error("no chromium app binary in ms-playwright cache");
  return playwright.chromium.launch({ headless: true, executablePath: exec });
}

// Open a browser /ws with a cookie; resolve {ok, ws|code}.
function openWs(WebSocket, cookie) {
  return new Promise((resolve) => {
    const ws = new WebSocket(WS_URL, cookie ? { headers: { Cookie: cookie } } : {});
    let settled = false;
    ws.on("open", () => { if (!settled) { settled = true; resolve({ ok: true, ws }); } });
    ws.on("unexpected-response", (_q, res) => { if (!settled) { settled = true; resolve({ ok: false, code: res.statusCode, ws: null }); } });
    ws.on("error", (e) => { if (!settled) { settled = true; resolve({ ok: false, error: String(e), ws: null }); } });
  });
}

module.exports = {
  api, sleep, spawnSession, driveAskSelect, shutdown, sessDir, sessLog, socketProof, readDetails,
  jsonlHasUndefinedDecision, launchBrowser, findChromium, openWs, mintToken, cookieFor,
  BASE, WS_URL, WS, MARKER, SESS, SECRET, OPERATOR, GUEST, OP_COOKIE, GUEST_COOKIE,
};
