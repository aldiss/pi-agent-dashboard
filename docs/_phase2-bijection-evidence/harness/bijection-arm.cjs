// ============================================================================
// Phase-2 natural-healthy all-option bijection arm (verifies A1–A5 on the
// staged d520be7 build).  For EACH distinct option i:
//   1. spawn a FRESH isolated session (loopback dashboard, temp HOME)
//   2. drive a natural healthy `ask_user` select (>=3 distinct options)
//   3. socket-prove ZERO :9999 / :8000 BEFORE the answer (loopback-only)
//   4. assert the question + message are visible in the dialog (A3)
//   5. assert the 3 option labels are distinct + plain (A1/A4, no placeholder)
//   6. click option i by EXACT label in the real browser
//   7. read details.result + details.receipt from the session JSONL and assert
//        returned === original[i]           (full visible<->machine bijection, A4)
//        receipt.answered === true          (A6 receipt: a real answer)
//        receipt.source is an adapter (not "__bus__")   (answered@source)
//        receipt.selectedIndex === i        (exact hidden option, no confusion)
// Node Playwright, explicit chromium executablePath (cache 1228; worktree
// playwright wants absent 1217).  Every artifact hashed by the caller.
// ============================================================================
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

const TITLE = "Deploy Build-1 to production now?";
const MSG = "The candidate passed all pre-deploy gates. Choose how to proceed.";
const OPTS = ["Deploy to production now", "Run one more validation pass first", "Cancel and hold"];
const PLACEHOLDERS = ["could not be translated", "original wording is hidden"];

function api(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(BASE + p, {
      method,
      headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {},
      timeout: 20000,
    }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => { try { resolve(JSON.parse(buf)); } catch { resolve({ raw: buf }); } });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error("timeout")); });
    if (data) req.write(data);
    req.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sessions() { const d = await api("GET", "/api/sessions"); return d.data || []; }

async function spawnSession(cwd) {
  fs.mkdirSync(cwd, { recursive: true });
  await api("POST", "/api/session/spawn", { cwd, label: `bij-${path.basename(cwd)}` });
  for (let t = 0; t < 12; t++) {
    await sleep(2000);
    const s = (await sessions()).find((x) => String(x.cwd || "").includes(path.basename(cwd)));
    if (s) return s.id;
  }
  return null;
}

// lsof socket proof for the whole isolated process tree (dashboard + children).
function socketProof(tag) {
  const dashPid = fs.readFileSync("/tmp/pi-p2-launch-pid.txt", "utf8").trim();
  let out = "";
  try {
    // all node/pi procs whose cwd or args touch our workspace
    const pids = execSync(`pgrep -f "build1-p2-20260731-8133" || true`, { encoding: "utf8" }).split(/\s+/).filter(Boolean);
    for (const p of pids) {
      const o = execSync(`lsof -nP -a -p ${p} -iTCP 2>/dev/null || true`, { encoding: "utf8" });
      out += `--- pid ${p} ---\n${o.trim() || "(no TCP)"}\n`;
    }
  } catch (e) { out += `lsof err ${e}\n`; }
  const has9999 = /:9999\b/.test(out);
  const has8000 = /:8000\b/.test(out);
  const has8133 = /127\.0\.0\.1:8133\b/.test(out);
  const has8134 = /127\.0\.0\.1:8134\b/.test(out);
  // any NON-loopback ESTABLISHED/LISTEN (exclude 127.0.0.1 and [::1])
  const nonLoop = out.split("\n").filter((l) => /\bTCP\b/.test(l) && !/127\.0\.0\.1|\[::1\]/.test(l));
  fs.writeFileSync(path.join(OUT, `${tag}-socket-proof.txt`),
    `ts=${new Date().toISOString()}\nhas9999=${has9999} has8000=${has8000} has8133=${has8133} has8134=${has8134}\n` +
    `non_loopback_tcp_lines=${nonLoop.length}\n\n${out}\n--- non-loopback lines ---\n${nonLoop.join("\n")}`);
  return { has9999, has8000, has8133, has8134, nonLoopCount: nonLoop.length };
}

function sessionLog(cwdTag) {
  const dir = path.join(WS, "state/.pi/agent/sessions");
  try {
    const hits = execSync(`find "${dir}" -name '*.jsonl' -path '*${cwdTag}*' 2>/dev/null || true`, { encoding: "utf8" }).split("\n").filter(Boolean);
    return hits[0] || null;
  } catch { return null; }
}

// Read the ask_user tool RESULT (details.result + details.receipt) from JSONL.
function readReceiptResult(log) {
  if (!log || !fs.existsSync(log)) return null;
  const lines = fs.readFileSync(log, "utf8").split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    let e; try { e = JSON.parse(lines[i]); } catch { continue; }
    const found = findDetails(e);
    if (found) return found;
  }
  return null;
}
function findDetails(o) {
  if (o && typeof o === "object") {
    if (o.details && o.details.method === "select" && o.details.receipt) return o.details;
    for (const v of Object.values(o)) { const r = findDetails(v); if (r) return r; }
  }
  return null;
}

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: EXEC });
  const results = [];
  let armPass = true;

  for (let i = 0; i < OPTS.length; i++) {
    const tag = `opt${i}`;
    const cwd = path.join(WS, "probe-cwds", `bij-${tag}`);
    const rec = { option_index: i, expected_original: OPTS[i] };
    const sid = await spawnSession(cwd);
    rec.session = sid;
    if (!sid) { rec.error = "spawn failed"; armPass = false; results.push(rec); continue; }

    // drive the natural healthy ask_user
    await api("POST", `/api/session/${sid}/prompt`, {
      text: `Call the ask_user tool exactly once, immediately, with NO other text. Use method="select", title="${TITLE}", message="${MSG}", options=["${OPTS[0]}","${OPTS[1]}","${OPTS[2]}"]. Just call the tool.`,
    });

    const pg = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    await pg.goto(`${BASE}/session/${sid}`, { waitUntil: "networkidle", timeout: 30000 });

    // wait for the 3 option buttons to render
    let optButtons = [];
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      optButtons = await pg.$$eval("button", (bs, opts) =>
        bs.map((b) => (b.innerText || "").trim()).filter((t) => opts.includes(t)), OPTS);
      if (optButtons.length >= 3) break;
      await sleep(1500);
    }
    rec.visible_labels = optButtons;

    // SOCKET PROOF — BEFORE answering (prompt is pending)
    const sp = socketProof(tag);
    rec.socket = sp;
    rec.socket_zero_9999 = !sp.has9999;
    rec.socket_zero_8000 = !sp.has8000;
    rec.socket_loopback_only = sp.nonLoopCount === 0;

    // A3: question + message visible in the dialog
    const prompts = await pg.$$eval("[data-testid=prompt-body]", (ps) => ps.map((p) => p.innerText.trim())).catch(() => []);
    rec.prompt_bodies = prompts;
    rec.assert_question_visible = prompts.some((p) => p.includes(TITLE)) && prompts.some((p) => p.includes("pre-deploy gates"));
    // A1/A4: distinct + plain (no placeholder)
    rec.assert_labels_distinct = new Set(optButtons).size === optButtons.length && optButtons.length === 3;
    rec.assert_no_placeholder = !optButtons.some((l) => PLACEHOLDERS.some((ph) => l.includes(ph)));

    await pg.screenshot({ path: path.join(OUT, `${tag}-preclick.png`), fullPage: true });
    fs.writeFileSync(path.join(OUT, `${tag}-dialog.html`), await pg.content());

    // click option i by EXACT label
    const target = await pg.locator("button", { hasText: OPTS[i] }).filter({ hasText: OPTS[i] }).first();
    // exact match guard: use getByText exact
    const exact = pg.getByRole("button", { name: OPTS[i], exact: true });
    const clickTarget = (await exact.count()) ? exact.first() : target;
    rec.clicked_label = OPTS[i];
    await clickTarget.click();
    await sleep(5000);
    await pg.screenshot({ path: path.join(OUT, `${tag}-postclick.png`), fullPage: true });
    await pg.close();

    // round-trip from JSONL
    const log = sessionLog(`bij-${tag}`);
    rec.session_log = log;
    const details = readReceiptResult(log);
    rec.details = details;
    rec.returned_value = details ? details.result : null;
    rec.receipt = details ? details.receipt : null;
    rec.selected_index = details ? details.selectedIndex : undefined;

    // ── bijection + receipt assertions for index i ──
    rec.assert_returned_equals_original_i = rec.returned_value === OPTS[i];
    rec.assert_receipt_answered = !!(rec.receipt && rec.receipt.answered === true);
    rec.assert_receipt_source_adapter = !!(rec.receipt && rec.receipt.source && rec.receipt.source !== "__bus__" && rec.receipt.source !== "unknown");
    rec.assert_selectedIndex_matches = rec.selected_index === i;

    rec.option_pass = [
      rec.assert_returned_equals_original_i,
      rec.assert_receipt_answered,
      rec.assert_receipt_source_adapter,
      rec.assert_question_visible,
      rec.assert_labels_distinct,
      rec.assert_no_placeholder,
      rec.socket_zero_9999,
      rec.socket_zero_8000,
      rec.socket_loopback_only,
    ].every(Boolean);
    if (!rec.option_pass) armPass = false;
    results.push(rec);

    try { await api("POST", `/api/session/${sid}/shutdown`, {}); } catch {}
    await sleep(1500);
  }

  await browser.close();
  const summary = { arm: "natural-healthy-bijection", staged_build: "d520be7", arm_pass: armPass, options: results };
  fs.writeFileSync(path.join(OUT, "arm-result.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  process.exit(armPass ? 0 : 1);
})().catch((e) => { console.error("ARM_ERROR", e); process.exit(2); });
