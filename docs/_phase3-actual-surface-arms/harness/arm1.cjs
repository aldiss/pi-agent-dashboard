// Arm 1 — opt1 bijection on the staged 1c0769b build. Drive the natural healthy
// select, click "Run one more validation pass first" (index 1), assert:
//   returned == original[1]  (bijection)
//   receipt answered@dashboard-source
//   question visible + 3 distinct plain labels
//   zero :9999 / :8000 before the click (loopback-only)
const playwright = require("playwright");
const fs = require("fs");
const path = require("path");
const H = require("./lib.cjs");

const OUT = path.join(H.WS, "evidence", "arm1");
fs.mkdirSync(OUT, { recursive: true });
const TITLE = "Deploy Build-1 to production now?";
const MSG = "The candidate passed all pre-deploy gates. Choose how to proceed.";
const OPTS = ["Deploy to production now", "Run one more validation pass first", "Cancel and hold"];
const PLACEHOLDERS = ["could not be translated", "original wording is hidden"];
const I = 1;

(async () => {
  const tag = "arm1-opt1";
  const sid = await H.spawnSession(tag);
  const rec = { arm: "opt1-bijection", option_index: I, expected_original: OPTS[I], session: sid };
  if (!sid) { rec.error = "spawn failed"; fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(rec, null, 2)); console.log(JSON.stringify(rec)); process.exit(1); }

  await H.api("POST", `/api/session/${sid}/prompt`, { text: `Call the ask_user tool exactly once, immediately, with NO other text. Use method="select", title="${TITLE}", message="${MSG}", options=["${OPTS[0]}","${OPTS[1]}","${OPTS[2]}"]. Just call the tool.` });

  const browser = await H.launchBrowser(playwright);
  const pg = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  await pg.goto(`${H.BASE}/session/${sid}`, { waitUntil: "networkidle", timeout: 30000 });
  let vis = [];
  const dl = Date.now() + 60000;
  while (Date.now() < dl) { vis = await pg.$$eval("button", (bs, opts) => bs.map((b) => (b.innerText || "").trim()).filter((t) => opts.includes(t)), OPTS); if (vis.length >= 3) break; await H.sleep(1500); }
  rec.visible_labels = vis;

  const sp = H.socketProof(tag, OUT);
  rec.socket = sp;
  const prompts = await pg.$$eval("[data-testid=prompt-body]", (ps) => ps.map((p) => p.innerText.trim())).catch(() => []);
  rec.prompt_bodies = prompts;
  await pg.screenshot({ path: path.join(OUT, "preclick.png"), fullPage: true });
  fs.writeFileSync(path.join(OUT, "dialog.html"), await pg.content());

  await pg.getByRole("button", { name: OPTS[I], exact: true }).first().click();
  let details = null;
  for (let t = 0; t < 12; t++) { await H.sleep(2000); details = H.readDetails(tag, "select"); if (details && details.receipt && details.receipt.answered) break; }
  await pg.screenshot({ path: path.join(OUT, "postclick.png"), fullPage: true });
  await browser.close();

  rec.returned_value = details ? details.result : null;
  rec.receipt = details ? details.receipt : null;
  rec.selectedIndex = details ? details.selectedIndex : undefined;
  const r = rec.receipt || {};
  rec.assert_bijection = rec.returned_value === OPTS[I];
  rec.assert_selectedIndex = rec.selectedIndex === I;
  rec.assert_answered = r.answered === true;
  rec.assert_source_dashboard = typeof r.source === "string" && r.source.startsWith("dashboard");
  rec.assert_question_visible = prompts.some((p) => p.includes(TITLE)) && prompts.some((p) => p.includes("pre-deploy gates"));
  rec.assert_labels_distinct = new Set(vis).size === vis.length && vis.length === 3;
  rec.assert_no_placeholder = !vis.some((l) => PLACEHOLDERS.some((ph) => l.includes(ph)));
  rec.assert_zero_9999 = !sp.has9999;
  rec.assert_zero_8000 = !sp.has8000;
  rec.assert_loopback_only = sp.nonLoop === 0;
  rec.PASS = Object.entries(rec).filter(([k]) => k.startsWith("assert_")).every(([, v]) => v);
  fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(rec, null, 2));
  console.log(JSON.stringify(rec, null, 2));
  try { await H.api("POST", `/api/session/${sid}/shutdown`, {}); } catch {}
  process.exit(rec.PASS ? 0 : 1);
})().catch((e) => { console.error("ARM1_ERROR", e); process.exit(2); });
