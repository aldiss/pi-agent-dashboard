// Single-option bijection runner — one option index at a time, generous
// settle + spawn-confirm (waits for the session JSONL to exist before driving,
// and polls the JSONL for the answered receipt after the click). Same asserts
// as bijection-arm.cjs. Fixes the nonLoop "(no TCP)" false-positive.
//   usage: node bijection-one.cjs <optionIndex>
const { chromium } = require("playwright");
const http = require("http");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const EXEC = "/Users/vdrobkov/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const BASE = "http://127.0.0.1:8133";
const WS = "/tmp/build1-p2-20260731-8133";
const OUT = path.join(WS, "evidence", "bijection");
fs.mkdirSync(OUT, { recursive: true });
const SESS = path.join(WS, "state/.pi/agent/sessions");

const TITLE = "Deploy Build-1 to production now?";
const MSG = "The candidate passed all pre-deploy gates. Choose how to proceed.";
const OPTS = ["Deploy to production now", "Run one more validation pass first", "Cancel and hold"];
const PLACEHOLDERS = ["could not be translated", "original wording is hidden"];
const I = parseInt(process.argv[2], 10);

function api(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(BASE + p, { method, headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}, timeout: 25000 }, (res) => {
      let buf = ""; res.on("data", (c) => (buf += c)); res.on("end", () => { try { resolve(JSON.parse(buf)); } catch { resolve({ raw: buf }); } });
    });
    req.on("error", reject); req.on("timeout", () => req.destroy(new Error("timeout")));
    if (data) req.write(data); req.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function sessions() { const d = await api("GET", "/api/sessions"); return d.data || []; }
function sessDir(tag) { const h = execSync(`find "${SESS}" -maxdepth 1 -type d -path '*${tag}*' 2>/dev/null || true`, { encoding: "utf8" }).split("\n").filter(Boolean); return h[0] || null; }
function sessLog(tag) { const d = sessDir(tag); if (!d) return null; const h = execSync(`find "${d}" -name '*.jsonl' 2>/dev/null || true`, { encoding: "utf8" }).split("\n").filter(Boolean); return h[0] || null; }

function socketProof(tag) {
  let out = "";
  const pids = execSync(`pgrep -f "build1-p2-20260731-8133" || true`, { encoding: "utf8" }).split(/\s+/).filter(Boolean);
  for (const p of pids) { const o = execSync(`lsof -nP -a -p ${p} -iTCP 2>/dev/null || true`, { encoding: "utf8" }); out += `--- pid ${p} ---\n${o.trim() || "(no TCP)"}\n`; }
  const has9999 = /:9999\b/.test(out), has8000 = /:8000\b/.test(out);
  // Non-loopback = a real TCP socket line (has an IP:port arrow or LISTEN) that
  // is NOT 127.0.0.1 / [::1]. Exclude header/placeholder lines.
  const nonLoop = out.split("\n").filter((l) => /\b(LISTEN|ESTABLISHED)\b/.test(l) && !/127\.0\.0\.1|\[::1\]/.test(l));
  fs.writeFileSync(path.join(OUT, `${tag}-socket-proof.txt`), `ts=${new Date().toISOString()}\nhas9999=${has9999} has8000=${has8000}\nnon_loopback=${nonLoop.length}\n\n${out}\n--- non-loopback ---\n${nonLoop.join("\n")}`);
  return { has9999, has8000, nonLoop: nonLoop.length };
}
function readDetails(log) {
  if (!log || !fs.existsSync(log)) return null;
  const lines = fs.readFileSync(log, "utf8").split("\n").filter(Boolean);
  let found = null;
  const w = (o) => { if (o && typeof o === "object") { if (o.method === "select" && o.receipt) found = o; for (const v of Object.values(o)) w(v); } };
  for (const l of lines) { try { w(JSON.parse(l)); } catch {} }
  return found;
}

(async () => {
  const tag = `one-opt${I}`;
  const cwd = path.join(WS, "probe-cwds", `bij-${tag}`);
  fs.mkdirSync(cwd, { recursive: true });
  await api("POST", "/api/session/spawn", { cwd, label: `bij-${tag}` });
  // wait for session to appear (60s window per directive)
  let sid = null;
  for (let t = 0; t < 30; t++) { await sleep(2000); const s = (await sessions()).find((x) => String(x.cwd || "").includes(`bij-${tag}`)); if (s) { sid = s.id; break; } }
  if (!sid) { console.log(JSON.stringify({ option_index: I, error: "spawn failed" })); process.exit(1); }
  // wait for the session JSONL to exist (confirms the agent booted)
  for (let t = 0; t < 15; t++) { if (sessLog(`bij-${tag}`)) break; await sleep(2000); }

  await api("POST", `/api/session/${sid}/prompt`, { text: `Call the ask_user tool exactly once, immediately, with NO other text. Use method="select", title="${TITLE}", message="${MSG}", options=["${OPTS[0]}","${OPTS[1]}","${OPTS[2]}"]. Just call the tool.` });

  const browser = await chromium.launch({ headless: true, executablePath: EXEC });
  const pg = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  await pg.goto(`${BASE}/session/${sid}`, { waitUntil: "networkidle", timeout: 30000 });
  // wait up to 90s for the 3 option buttons
  let vis = [];
  const dl = Date.now() + 90000;
  while (Date.now() < dl) { vis = await pg.$$eval("button", (bs, opts) => bs.map((b) => (b.innerText || "").trim()).filter((t) => opts.includes(t)), OPTS); if (vis.length >= 3) break; await sleep(1500); }

  const sp = socketProof(tag);
  const prompts = await pg.$$eval("[data-testid=prompt-body]", (ps) => ps.map((p) => p.innerText.trim())).catch(() => []);
  await pg.screenshot({ path: path.join(OUT, `${tag}-preclick.png`), fullPage: true });
  fs.writeFileSync(path.join(OUT, `${tag}-dialog.html`), await pg.content());

  const exact = pg.getByRole("button", { name: OPTS[I], exact: true });
  await exact.first().click();
  // poll the JSONL for the answered receipt (up to 20s)
  let details = null;
  for (let t = 0; t < 10; t++) { await sleep(2000); details = readDetails(sessLog(`bij-${tag}`)); if (details && details.receipt && details.receipt.answered) break; }
  await pg.screenshot({ path: path.join(OUT, `${tag}-postclick.png`), fullPage: true });
  await browser.close();

  const r = details ? details.receipt : null;
  const rec = {
    option_index: I, session: sid, expected_original: OPTS[I],
    visible_labels: vis, prompt_bodies: prompts,
    returned_value: details ? details.result : null, receipt: r, selectedIndex: details ? details.selectedIndex : undefined,
    socket: sp,
    assert_returned_equals_original_i: details ? details.result === OPTS[I] : false,
    assert_receipt_answered: !!(r && r.answered === true),
    assert_receipt_source_adapter: !!(r && r.source && r.source !== "__bus__" && r.source !== "unknown"),
    assert_selectedIndex_matches: details ? details.selectedIndex === I : false,
    assert_question_visible: prompts.some((p) => p.includes(TITLE)) && prompts.some((p) => p.includes("pre-deploy gates")),
    assert_labels_distinct: new Set(vis).size === vis.length && vis.length === 3,
    assert_no_placeholder: !vis.some((l) => PLACEHOLDERS.some((ph) => l.includes(ph))),
    assert_socket_zero_9999: !sp.has9999,
    assert_socket_zero_8000: !sp.has8000,
    assert_socket_loopback_only: sp.nonLoop === 0,
  };
  rec.option_pass = Object.entries(rec).filter(([k]) => k.startsWith("assert_")).every(([, v]) => v);
  fs.writeFileSync(path.join(OUT, `${tag}-result.json`), JSON.stringify(rec, null, 2));
  console.log(JSON.stringify(rec, null, 2));
  try { await api("POST", `/api/session/${sid}/shutdown`, {}); } catch {}
  process.exit(rec.option_pass ? 0 : 1);
})().catch((e) => { console.error("ERR", e); process.exit(2); });
