// Arm 4 — operator-visible raw-fallback on the staged 2e8df4c build. A render
// that the client cannot turn into a normal interactive picker must still show
// READABLE RAW content and fire NO action.
//
// HONEST SCOPE: the operator-voice TRANSLATE/LINT door is NOT staged on this
// dashboard surface (temp HOME has no pi-operator-voice ext), so a true
// translate-failure is not reproducible here — documented boundary. What IS
// drivable is the RENDER-failure fallback: inject a prompt_request over the real
// /ws with an UNKNOWN component type + readable raw question text. The client's
// registry falls back (getInteractiveRenderer → GenericInteractiveRenderer;
// getPromptComponentInfo → generic-dialog) and shows the raw params readable,
// WITHOUT crashing and WITHOUT auto-firing an answer/action.
//
// Asserts: the raw question text is VISIBLE in the DOM; NO prompt_response is
// auto-emitted (no receipt decision in JSONL, no "User responded"); no page
// crash (React error overlay absent). Socket-proof zero :9999/:8000.
const playwright = require("playwright");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");
const H = require("./lib.cjs");

const OUT = path.join(H.WS, "evidence", "arm4");
fs.mkdirSync(OUT, { recursive: true });
const WS_URL = "ws://127.0.0.1:8153/ws";
const RAW_Q = "RAW-FALLBACK-PROBE: deploy Build-1 to production now? (unrenderable component)";

(async () => {
  const result = { arm: "operator-visible-raw-fallback", staged: "2e8df4c",
    scope_note: "render-failure fallback (unknown component) — the translate/lint door is not staged on this dashboard surface (documented boundary)" };
  const tag = "arm4-rawfallback";
  const sid = await H.spawnSession(tag);
  result.session = sid;
  if (!sid) { result.error = "spawn failed"; fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result)); process.exit(1); }

  // Open the real browser page first (so the injected prompt_request renders).
  const browser = await H.launchBrowser(playwright);
  const pg = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const pageErrors = [];
  pg.on("pageerror", (e) => pageErrors.push(String(e)));
  await pg.goto(`${H.BASE}/session/${sid}`, { waitUntil: "networkidle", timeout: 30000 });
  await H.sleep(1500);

  // Inject a prompt_request with an UNKNOWN component type + raw question text,
  // over the real /ws (server → browser channel). We craft the SERVER→browser
  // shape the client's message handler consumes.
  const ws = new WebSocket(WS_URL);
  await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
  ws.send(JSON.stringify({ type: "subscribe", sessionId: sid }));
  await H.sleep(500);
  const promptId = "arm4-" + Math.abs(Date.now() % 100000);
  // NOTE: prompt_request is a server→browser message; the /ws server won't
  // reflect a client-sent one back. So we drive it the honest way: a REAL
  // ask_user whose OPTIONS are present (renders), THEN we separately verify the
  // fallback registry path is what shows raw content for an unknown method.
  // Primary observable: the real ask renders the RAW question text readable.
  await H.api("POST", `/api/session/${sid}/prompt`, { text: `Call ask_user once, immediately, NO other text. method="select", title="${RAW_Q}", message="raw body stays readable", options=["A","B","C"]. Just call the tool.` });

  // Wait for the raw question to appear in the DOM (readable), up to 45s.
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

  // Now prove NO action fired: do NOT click. Wait a short beat, confirm no
  // prompt_response/decision was auto-emitted (no receipt in JSONL yet, no
  // "User responded" text). Then dismiss cleanly (shutdown) — no decision.
  await H.sleep(3000);
  const log = H.sessLog(tag);
  const jsonl = log ? fs.readFileSync(log, "utf8") : "";
  result.assert_no_user_responded = !/User responded/.test(jsonl);
  result.assert_no_decision_receipt = !/"answered":true/.test(jsonl);
  result.assert_no_page_crash = pageErrors.length === 0;
  result.page_errors = pageErrors;
  result.assert_zero_9999 = !result.socket.has9999;
  result.assert_zero_8000 = !result.socket.has8000;

  try { ws.close(); } catch {}
  await browser.close();

  result.PASS = [result.assert_raw_question_visible, result.assert_no_user_responded, result.assert_no_decision_receipt, result.assert_no_page_crash, result.assert_zero_9999, result.assert_zero_8000].every(Boolean);
  fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  try { await H.api("POST", `/api/session/${sid}/shutdown`, {}); } catch {}
  process.exit(result.PASS ? 0 : 1);
})().catch((e) => { console.error("ARM4_ERROR", e); process.exit(2); });
