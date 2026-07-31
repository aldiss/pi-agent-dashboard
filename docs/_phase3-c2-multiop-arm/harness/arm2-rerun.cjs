// Arm 2 re-run (A1-live regression) on the MULTI-OP C2 dashboard — confirms the
// C1 at-least-once change did not regress the real mount-ACK. Operator JWT
// cookie on all calls (multi-op mode). Same contrast: RENDERED-then-timeout
// (browser mounts card → real prompt_rendered ACK) → delivered:true/rendered:true;
// NEVER-RENDERED (no browser) → delivered:false/rendered:false. 8s bus timeout.
const playwright = require("playwright");
const jwt = require("jsonwebtoken");
const http = require("http");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const EXEC = "/Users/vdrobkov/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const SECRET = "c2-multiop-test-secret-8153";
const BASE = "http://127.0.0.1:8153";
const WS = "/tmp/build1-p3c2-20260731-8153";
const OUT = path.join(WS, "evidence", "arm2-rerun");
fs.mkdirSync(OUT, { recursive: true });
const SESS = path.join(WS, "state/.pi/agent/sessions");
const OPCOOKIE = "pi_dash_token=" + jwt.sign({ sub: "operator@op", name: "Operator One", username: "operator", provider: "test" }, SECRET, { expiresIn: "7d" });
const TITLE = "Deploy Build-1 to production now?";
const OPTS = ["Deploy to production now", "Run one more validation pass first", "Cancel and hold"];

function api(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { Cookie: OPCOOKIE };
    if (data) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = Buffer.byteLength(data); }
    const req = http.request(BASE + p, { method, headers, timeout: 25000 }, (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => { try { resolve(JSON.parse(b)); } catch { resolve({ raw: b }); } }); });
    req.on("error", reject); req.on("timeout", () => req.destroy(new Error("timeout")));
    if (data) req.write(data); req.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function sessDir(tag) { const h = execSync(`find "${SESS}" -maxdepth 1 -type d -path '*${tag}*' 2>/dev/null || true`, { encoding: "utf8" }).split("\n").filter(Boolean); return h[0] || null; }
function sessLog(tag) { const d = sessDir(tag); if (!d) return null; const h = execSync(`find "${d}" -name '*.jsonl' 2>/dev/null || true`, { encoding: "utf8" }).split("\n").filter(Boolean); return h[0] || null; }
function readReceipt(tag) { const log = sessLog(tag); if (!log || !fs.existsSync(log)) return null; let f = null; const w = (o) => { if (o && typeof o === "object") { if (o.method === "select" && o.receipt) f = o; for (const v of Object.values(o)) w(v); } }; for (const l of fs.readFileSync(log, "utf8").split("\n").filter(Boolean)) { try { w(JSON.parse(l)); } catch {} } return f; }
async function spawn(tag) { const cwd = path.join(WS, "probe-cwds", tag); fs.mkdirSync(cwd, { recursive: true }); await api("POST", "/api/session/spawn", { cwd, label: tag }); for (let t = 0; t < 30; t++) { await sleep(2000); const r = await api("GET", "/api/sessions"); const s = ((r && r.data) || []).find((x) => String(x.cwd || "").includes(tag)); if (s) { for (let u = 0; u < 12; u++) { if (sessLog(tag)) break; await sleep(2000); } return s.id; } } return null; }
function socketProof(tag) { let out = ""; const pids = execSync(`pgrep -f "build1-p3c2-20260731-8153" || true`, { encoding: "utf8" }).split(/\s+/).filter(Boolean); for (const p of pids) { out += execSync(`lsof -nP -a -p ${p} -iTCP 2>/dev/null || true`, { encoding: "utf8" }); } const has9999 = /:9999\b/.test(out), has8000 = /:8000\b/.test(out); return { has9999, has8000 }; }

(async () => {
  const result = { arm: "arm2-A1-live-RERUN-on-multiop", staged: "worktree(C1+C2)" };
  // (a) RENDERED-then-timeout — operator browser mounts the card → real ACK.
  const tagA = "rerun-rendered-" + Date.now();
  const sidA = await spawn(tagA);
  result.rendered = { session: sidA };
  if (sidA) {
    await api("POST", `/api/session/${sidA}/prompt`, { text: `Call ask_user once, immediately, NO other text. method="select", title="${TITLE}", message="c", options=["${OPTS[0]}","${OPTS[1]}","${OPTS[2]}"]. Just call the tool.` });
    const browser = await playwright.chromium.launch({ headless: true, executablePath: EXEC });
    // Set the operator cookie so the browser page authenticates (multi-op).
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    await ctx.addCookies([{ name: "pi_dash_token", value: OPCOOKIE.split("=")[1], domain: "127.0.0.1", path: "/" }]);
    const pg = await ctx.newPage();
    await pg.goto(`${BASE}/session/${sidA}`, { waitUntil: "networkidle", timeout: 30000 });
    let vis = []; const dl = Date.now() + 40000;
    while (Date.now() < dl) { vis = await pg.$$eval("button", (bs, o) => bs.map((b) => (b.innerText || "").trim()).filter((t) => o.includes(t)), OPTS); if (vis.length >= 3) break; await sleep(1200); }
    result.rendered.dialog_mounted = vis.length >= 3;
    await pg.screenshot({ path: path.join(OUT, "rendered-mounted.png"), fullPage: true });
    result.rendered.socket = socketProof("rerun");
    await sleep(12000); // wait out the 8s bus timeout WITHOUT answering
    await browser.close();
    const det = readReceipt(tagA); const r = det ? det.receipt : null;
    result.rendered.receipt = r;
    result.rendered.assert_timedOut = !!(r && r.timedOut);
    result.rendered.assert_delivered_true = !!(r && r.delivered === true);
    result.rendered.assert_rendered_true = !!(r && r.rendered === true);
    try { await api("POST", `/api/session/${sidA}/shutdown`, {}); } catch {}
  } else result.rendered.error = "spawn failed";

  await sleep(1500);
  // (b) NEVER-RENDERED — no browser, no ACK.
  const tagB = "rerun-never-" + Date.now();
  const sidB = await spawn(tagB);
  result.never = { session: sidB };
  if (sidB) {
    await api("POST", `/api/session/${sidB}/prompt`, { text: `Call ask_user once, immediately, NO other text. method="select", title="${TITLE}", message="c", options=["${OPTS[0]}","${OPTS[1]}","${OPTS[2]}"]. Just call the tool.` });
    await sleep(2000); result.never.socket = socketProof("rerun-never");
    await sleep(12000);
    const det = readReceipt(tagB); const r = det ? det.receipt : null;
    result.never.receipt = r;
    result.never.assert_timedOut = !!(r && r.timedOut);
    result.never.assert_delivered_false = !!(r && r.delivered === false);
    result.never.assert_rendered_false = !!(r && r.rendered === false);
    try { await api("POST", `/api/session/${sidB}/shutdown`, {}); } catch {}
  } else result.never.error = "spawn failed";

  result.A1_LIVE_STILL_HOLDS = !!(result.rendered.assert_delivered_true && result.rendered.assert_rendered_true && result.rendered.assert_timedOut && result.never.assert_delivered_false && result.never.assert_rendered_false && result.never.assert_timedOut);
  fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.A1_LIVE_STILL_HOLDS ? 0 : 1);
})().catch((e) => { console.error("RERUN_ERROR", e); process.exit(2); });
