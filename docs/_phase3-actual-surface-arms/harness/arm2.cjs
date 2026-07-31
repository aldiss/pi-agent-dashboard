// Arm 2 — A1 LIVE render-ACK proof on the staged 2e8df4c build (8s bus timeout).
// Two sub-cases, contrasted:
//   (a) RENDERED-then-timeout: open the browser so InteractiveUiCard MOUNTS and
//       the client sends a REAL prompt_rendered ACK (B1) — then DO NOT answer,
//       let the 8s PromptBus timeout fire. Receipt must be
//       delivered:true, rendered:true, timedOut:true, answered:false, and (B2)
//       author present (the authenticated operator who rendered it).
//   (b) NEVER-RENDERED: drive the same ask but open NO browser (no mount → no
//       ACK) — 8s timeout. Receipt must be delivered:false, rendered:false,
//       timedOut:true.
// The contrast proves `delivered/rendered` ride on ACTUAL dialog mount, not the
// old __bus__ heuristic. Socket-proof zero :9999/:8000 before each timeout.
const playwright = require("playwright");
const fs = require("fs");
const path = require("path");
const H = require("./lib.cjs");

const OUT = path.join(H.WS, "evidence", "arm2");
fs.mkdirSync(OUT, { recursive: true });
const TITLE = "Deploy Build-1 to production now?";
const MSG = "The candidate passed all pre-deploy gates. Choose how to proceed.";
const OPTS = ["Deploy to production now", "Run one more validation pass first", "Cancel and hold"];

async function driveAsk(sid) {
  await H.api("POST", `/api/session/${sid}/prompt`, { text: `Call the ask_user tool exactly once, immediately, with NO other text. Use method="select", title="${TITLE}", message="${MSG}", options=["${OPTS[0]}","${OPTS[1]}","${OPTS[2]}"]. Just call the tool.` });
}
// Read the LAST select receipt from JSONL (timed-out → result absent, receipt present).
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
  const result = { arm: "A1-live-rendered-vs-never", staged: "2e8df4c" };

  // ── (a) RENDERED-then-timeout ──
  const tagA = "arm2-rendered";
  const sidA = await H.spawnSession(tagA);
  result.rendered = { session: sidA };
  if (!sidA) { result.rendered.error = "spawn failed"; }
  else {
    await driveAsk(sidA);
    const browser = await H.launchBrowser(playwright);
    const pg = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    await pg.goto(`${H.BASE}/session/${sidA}`, { waitUntil: "networkidle", timeout: 30000 });
    // wait for the dialog to MOUNT (option buttons visible) — this fires the real ACK
    let vis = [];
    const dl = Date.now() + 40000;
    while (Date.now() < dl) { vis = await pg.$$eval("button", (bs, o) => bs.map((b) => (b.innerText || "").trim()).filter((t) => o.includes(t)), OPTS); if (vis.length >= 3) break; await H.sleep(1200); }
    result.rendered.dialog_mounted = vis.length >= 3;
    result.rendered.visible_labels = vis;
    await pg.screenshot({ path: path.join(OUT, "rendered-mounted.png"), fullPage: true });
    // socket proof BEFORE the timeout
    result.rendered.socket = H.socketProof("arm2-rendered", OUT);
    // DO NOT answer — keep the page open so it stays "rendered", wait out the 8s bus timeout
    await H.sleep(12000);
    await pg.screenshot({ path: path.join(OUT, "rendered-postTimeout.png"), fullPage: true });
    await browser.close();
    const det = readReceipt(tagA);
    result.rendered.details = det;
    const r = det ? det.receipt : null;
    result.rendered.receipt = r;
    result.rendered.assert_timedOut = !!(r && r.timedOut === true);
    result.rendered.assert_delivered_true = !!(r && r.delivered === true);
    result.rendered.assert_rendered_true = !!(r && r.rendered === true);
    result.rendered.assert_not_answered = !!(r && r.answered === false);
    result.rendered.assert_author_present = !!(r && r.author && r.author.sub);
    try { await H.api("POST", `/api/session/${sidA}/shutdown`, {}); } catch {}
  }

  await H.sleep(1500);

  // ── (b) NEVER-RENDERED (no browser) ──
  const tagB = "arm2-never";
  const sidB = await H.spawnSession(tagB);
  result.never = { session: sidB };
  if (!sidB) { result.never.error = "spawn failed"; }
  else {
    await driveAsk(sidB);
    // NO browser is opened → no mount → no prompt_rendered ACK. Socket proof, then wait out 8s timeout.
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
    result.never.assert_no_author = !(r && r.author);
    try { await H.api("POST", `/api/session/${sidB}/shutdown`, {}); } catch {}
  }

  // The A1-live contrast: rendered→delivered:true, never→delivered:false.
  result.A1_LIVE_CONTRAST_PROVEN =
    !!(result.rendered.assert_delivered_true && result.rendered.assert_rendered_true &&
       result.rendered.assert_timedOut && result.never.assert_delivered_false &&
       result.never.assert_rendered_false && result.never.assert_timedOut);
  result.rendered_socket_clean = !!(result.rendered.socket && !result.rendered.socket.has9999 && !result.rendered.socket.has8000);
  result.never_socket_clean = !!(result.never.socket && !result.never.socket.has9999 && !result.never.socket.has8000);
  fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.A1_LIVE_CONTRAST_PROVEN ? 0 : 1);
})().catch((e) => { console.error("ARM2_ERROR", e); process.exit(2); });
