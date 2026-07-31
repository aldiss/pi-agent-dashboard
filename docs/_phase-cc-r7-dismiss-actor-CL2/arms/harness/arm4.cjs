// CC-r7 arm4 — operator-visible raw-fallback on the staged CANDIDATE build
// (7fc75b5). A render the client cannot turn into a normal picker must still show
// READABLE RAW content and fire NO action.
//
// HONEST SCOPE: the operator-voice TRANSLATE/LINT door is NOT staged on this
// dashboard surface (temp HOME has no pi-operator-voice ext), so a true
// translate-failure is not reproducible here — documented boundary. What IS
// drivable is the RENDER path: a real ask_user whose raw question text is shown
// READABLE in the DOM, WITHOUT crashing and WITHOUT auto-firing an answer.
// Asserts: raw question text VISIBLE in DOM; NO prompt_response auto-emitted (no
// answered receipt, no "User responded"); no page crash. Socket zero :9999/:8000.
const playwright = require("playwright");
const fs = require("fs");
const path = require("path");
const H = require("./lib.cjs");

const OUT = path.join(H.WS, "evidence", "arm4");
fs.mkdirSync(OUT, { recursive: true });
const RAW_Q = "RAW-FALLBACK-PROBE: deploy Build-1 to production now? (unrenderable component)";
const STAGED = process.env.STAGED_HEAD || "worktree";

async function newOperatorPage(browser) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  await context.addCookies([{ name: "pi_dash_token", value: H.mintToken(H.OPERATOR), domain: "127.0.0.1", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }]);
  return { context, page: await context.newPage() };
}

(async () => {
  const result = { arm: "operator-visible-raw-fallback", staged_head: STAGED,
    scope_note: "render-path readable-raw (real ask_user); the translate/lint door is not staged on this dashboard surface (documented boundary)" };
  const tag = "arm4-rawfallback-" + Date.now();
  const sid = await H.spawnSession(tag);
  result.session = sid;
  if (!sid) { result.error = "spawn failed"; fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result)); process.exit(1); }

  const browser = await H.launchBrowser(playwright);
  const { context, page: pg } = await newOperatorPage(browser);
  const pageErrors = [];
  pg.on("pageerror", (e) => pageErrors.push(String(e)));
  await pg.goto(`${H.BASE}/session/${sid}`, { waitUntil: "networkidle", timeout: 30000 });
  await H.sleep(1500);

  await H.driveAskSelect(sid, RAW_Q, "raw body stays readable", ["A", "B", "C"]);

  let rawVisible = false;
  const dl = Date.now() + 45000;
  while (Date.now() < dl) {
    const body = await pg.innerText("body").catch(() => "");
    if (body.includes("RAW-FALLBACK-PROBE")) { rawVisible = true; break; }
    await H.sleep(1200);
  }
  result.assert_raw_question_visible = rawVisible;
  result.socket = H.socketProof(tag, OUT);
  await pg.screenshot({ path: path.join(OUT, "raw-visible.png"), fullPage: true });
  fs.writeFileSync(path.join(OUT, "dom.html"), await pg.content());
  result.screenshot = "raw-visible.png";

  // Prove NO action fired: do NOT click. Confirm no prompt_response/decision auto-emitted.
  await H.sleep(3000);
  const log = H.sessLog(tag);
  const jsonl = log ? fs.readFileSync(log, "utf8") : "";
  result.assert_no_user_responded = !/User responded/.test(jsonl);
  result.assert_no_decision_receipt = !/"answered":true/.test(jsonl);
  result.assert_no_page_crash = pageErrors.length === 0;
  result.page_errors = pageErrors;
  result.assert_zero_9999 = !result.socket.has9999;
  result.assert_zero_8000 = !result.socket.has8000;

  await context.close(); await browser.close();

  result.PASS = [result.assert_raw_question_visible, result.assert_no_user_responded, result.assert_no_decision_receipt, result.assert_no_page_crash, result.assert_zero_9999, result.assert_zero_8000].every(Boolean);
  fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  await H.shutdown(sid);
  process.exit(result.PASS ? 0 : 1);
})().catch((e) => { console.error("ARM4_ERROR", e); process.exit(2); });
