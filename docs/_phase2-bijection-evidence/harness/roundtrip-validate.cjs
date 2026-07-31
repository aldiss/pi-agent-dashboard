// Single-shot round-trip validation: answer the EXISTING pending session by
// clicking option index 1 ("Run one more validation pass first") and confirm
// the staged build writes details.result + details.receipt + selectedIndex to
// the session JSONL. De-risks the full 3-option arm.
const { chromium } = require("playwright");
const { execSync } = require("child_process");
const fs = require("fs");
const EXEC = "/Users/vdrobkov/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const BASE = "http://127.0.0.1:8133";
const SID = process.argv[2];
const WS = "/tmp/build1-p2-20260731-8133";
const OPTS = ["Deploy to production now", "Run one more validation pass first", "Cancel and hold"];
const PICK = 1;

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: EXEC });
  const pg = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  await pg.goto(`${BASE}/session/${SID}`, { waitUntil: "networkidle", timeout: 30000 });
  await pg.waitForTimeout(2000);
  const btn = pg.getByRole("button", { name: OPTS[PICK], exact: true });
  console.log("btn count", await btn.count());
  await btn.first().click();
  await pg.waitForTimeout(6000);
  await pg.screenshot({ path: `${WS}/evidence/roundtrip-validate-postclick.png`, fullPage: true });
  await browser.close();
  // read JSONL
  const dir = `${WS}/state/.pi/agent/sessions`;
  const log = execSync(`find "${dir}" -name '*${SID}*.jsonl' 2>/dev/null | head -1`, { encoding: "utf8" }).trim();
  console.log("LOG", log);
  const lines = fs.readFileSync(log, "utf8").split("\n").filter(Boolean);
  function find(o) {
    if (o && typeof o === "object") {
      if (o.details && o.details.method === "select" && "result" in o.details) return o.details;
      for (const v of Object.values(o)) { const r = find(v); if (r) return r; }
    }
    return null;
  }
  let details = null;
  for (let i = lines.length - 1; i >= 0 && !details; i--) { try { details = find(JSON.parse(lines[i])); } catch {} }
  console.log("DETAILS", JSON.stringify(details, null, 2));
  console.log("EXPECTED_RETURNED", OPTS[PICK]);
})().catch((e) => { console.error("ERR", e); process.exit(2); });
