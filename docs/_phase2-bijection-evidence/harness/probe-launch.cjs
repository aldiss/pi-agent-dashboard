// Time-boxed chromium launch probe — explicit executablePath to cached 1228
// build (worktree playwright wants 1217, absent). Loads the isolated session
// page and reports the option buttons it can see. Loopback-only.
const { chromium } = require("playwright");

const EXEC = "/Users/vdrobkov/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const SID = process.argv[2];
const BASE = "http://127.0.0.1:8133";

(async () => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: EXEC });
    console.log("LAUNCH_OK");
  } catch (e) {
    console.log("LAUNCH_FAIL", String(e).slice(0, 300));
    process.exit(2);
  }
  try {
    const pg = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    await pg.goto(`${BASE}/session/${SID}`, { waitUntil: "networkidle", timeout: 30000 });
    // Wait up to 30s for the ordinal option buttons ("1. ...", "2. ...").
    let labels = [];
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      labels = await pg.$$eval("button", (bs) =>
        bs.map((b) => (b.innerText || "").trim()).filter((t) => /^\d+\.\s/.test(t)),
      );
      if (labels.length >= 3) break;
      await pg.waitForTimeout(1000);
    }
    console.log("OPTION_BUTTONS", JSON.stringify(labels));
    await pg.screenshot({ path: "/tmp/build1-p2-20260731-8133/evidence/probe-render.png", fullPage: true });
    console.log("SCREENSHOT_OK");
    await browser.close();
    process.exit(labels.length >= 3 ? 0 : 3);
  } catch (e) {
    console.log("DRIVE_FAIL", String(e).slice(0, 300));
    try { await browser.close(); } catch {}
    process.exit(4);
  }
})();
