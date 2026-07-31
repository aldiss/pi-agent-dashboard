// CC-r7 arm2 — A1 LIVE render-ACK via REAL DOM MOUNT + SCREENSHOT on the staged
// CANDIDATE build (7fc75b5; 8s bus timeout). Pete dl-13527 requires a real browser
// mount (r6 used raw /ws injection because chromium was absent — now installed).
//
// The authenticated operator's browser navigates to /session/:sid; when the
// InteractiveUiCard dialog MOUNTS it fires the REAL prompt_rendered ACK (via
// usePromptRenderedAck) → the server stamps the operator author → markRendered →
// renderedBy. We then DO NOT answer and let the 8s PromptBus timeout fire.
// Receipt must be delivered:true, rendered:true, timedOut:true, answered:false,
// renderedBy=operator, author ABSENT (nobody answered).
// Contrast: a NEVER-rendered ask (no browser) → delivered:false, no renderedBy.
const playwright = require("playwright");
const fs = require("fs");
const path = require("path");
const H = require("./lib.cjs");

const OUT = path.join(H.WS, "evidence", "arm2");
fs.mkdirSync(OUT, { recursive: true });
const TITLE = "Deploy Build-1 to production now?";
const MSG = "The candidate passed all pre-deploy gates. Choose how to proceed.";
const OPTS = ["Deploy to production now", "Run one more validation pass first", "Cancel and hold"];
const STAGED = process.env.STAGED_HEAD || "worktree";

function readReceipt(tag) {
  const log = H.sessLog(tag);
  if (!log || !fs.existsSync(log)) return null;
  const lines = fs.readFileSync(log, "utf8").split("\n").filter(Boolean);
  let found = null;
  const w = (o) => { if (o && typeof o === "object") { if (o.method === "select" && o.receipt) found = o; for (const v of Object.values(o)) w(v); } };
  for (const l of lines) { try { w(JSON.parse(l)); } catch {} }
  return found;
}

// Authenticated operator browser context (carries the pi_dash_token cookie so the
// mount-fired prompt_rendered ACK is server-stamped with the operator identity).
async function newOperatorPage(browser) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  await context.addCookies([{ name: "pi_dash_token", value: H.mintToken(H.OPERATOR), domain: "127.0.0.1", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }]);
  return { context, page: await context.newPage() };
}

(async () => {
  const result = { arm: "A1-live-rendered-vs-never REAL-DOM (D1 renderedBy split)", staged_head: STAGED, chromium: H.findChromium() };

  // ── (a) RENDERED-then-timeout via REAL DOM mount ──
  const RUN = Date.now(); const tagA = "arm2-rendered-" + RUN;
  const sidA = await H.spawnSession(tagA);
  result.rendered = { session: sidA };
  if (sidA) {
    await H.driveAskSelect(sidA, TITLE, MSG, OPTS);
    const browser = await H.launchBrowser(playwright);
    const { context, page: pg } = await newOperatorPage(browser);
    await pg.goto(`${H.BASE}/session/${sidA}`, { waitUntil: "networkidle", timeout: 30000 });
    // Wait for the dialog to MOUNT (option buttons visible) — this fires the REAL ACK.
    let vis = [];
    const dl = Date.now() + 45000;
    while (Date.now() < dl) { vis = await pg.$$eval("button", (bs, o) => bs.map((b) => (b.innerText || "").trim()).filter((t) => o.includes(t)), OPTS); if (vis.length >= 3) break; await H.sleep(1200); }
    result.rendered.dialog_mounted = vis.length >= 3;
    result.rendered.visible_labels = vis;
    await pg.screenshot({ path: path.join(OUT, "rendered-mounted.png"), fullPage: true });
    fs.writeFileSync(path.join(OUT, "rendered-dialog.html"), await pg.content());
    result.rendered.screenshot = "rendered-mounted.png";
    result.rendered.socket = H.socketProof("arm2-rendered", OUT);
    // DO NOT answer — keep the page open so the dialog stays mounted; wait out the 8s bus timeout.
    await H.sleep(12000);
    await pg.screenshot({ path: path.join(OUT, "rendered-postTimeout.png"), fullPage: true });
    await context.close(); await browser.close();
    const det = readReceipt(tagA);
    result.rendered.details = det;
    const r = det ? det.receipt : null;
    result.rendered.receipt = r;
    result.rendered.assert_timedOut = !!(r && r.timedOut === true);
    result.rendered.assert_delivered_true = !!(r && r.delivered === true);
    result.rendered.assert_rendered_true = !!(r && r.rendered === true);
    result.rendered.assert_not_answered = !!(r && r.answered === false);
    result.rendered.assert_renderedBy_operator = !!(r && r.renderedBy && (r.renderedBy.username === "operator" || r.renderedBy.sub === "operator@op"));
    result.rendered.assert_author_absent = !(r && r.author);
    await H.shutdown(sidA);
  }

  await H.sleep(1500);

  // ── (b) NEVER-RENDERED (no browser) ──
  const tagB = "arm2-never-" + RUN;
  const sidB = await H.spawnSession(tagB);
  result.never = { session: sidB };
  if (sidB) {
    await H.driveAskSelect(sidB, TITLE, MSG, OPTS);
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
    await H.shutdown(sidB);
  }

  result.A1_LIVE_CONTRAST_PROVEN =
    !!(result.rendered.dialog_mounted && result.rendered.assert_delivered_true && result.rendered.assert_rendered_true &&
       result.rendered.assert_timedOut && result.rendered.assert_renderedBy_operator && result.rendered.assert_author_absent &&
       result.never.assert_delivered_false && result.never.assert_rendered_false &&
       result.never.assert_timedOut && result.never.assert_no_renderedBy && result.never.assert_no_author);
  result.rendered_socket_clean = !!(result.rendered.socket && !result.rendered.socket.has9999 && !result.rendered.socket.has8000);
  result.never_socket_clean = !!(result.never.socket && !result.never.socket.has9999 && !result.never.socket.has8000);
  fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.A1_LIVE_CONTRAST_PROVEN ? 0 : 1);
})().catch((e) => { console.error("ARM2_ERROR", e); process.exit(2); });
