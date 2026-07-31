// DOM structure probe — dump the option-button + prompt DOM so the bijection
// driver targets the real selectors (buttons are plain-label, not ordinal).
const { chromium } = require("playwright");
const fs = require("fs");
const EXEC = "/Users/vdrobkov/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const SID = process.argv[2];
const BASE = "http://127.0.0.1:8133";
const OUT = "/tmp/build1-p2-20260731-8133/evidence";

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: EXEC });
  const pg = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  await pg.goto(`${BASE}/session/${SID}`, { waitUntil: "networkidle", timeout: 30000 });
  await pg.waitForTimeout(2500);
  // Dump every button with its text + key attributes.
  const buttons = await pg.$$eval("button", (bs) =>
    bs.map((b, i) => ({
      i,
      text: (b.innerText || "").trim(),
      testid: b.getAttribute("data-testid"),
      cls: (b.className || "").slice(0, 80),
      aria: b.getAttribute("aria-label"),
    })).filter((x) => x.text),
  );
  fs.writeFileSync(`${OUT}/dom-buttons.json`, JSON.stringify(buttons, null, 2));
  // Find the 3 option buttons by their known labels.
  const OPTS = ["Deploy to production now", "Run one more validation pass first", "Cancel and hold"];
  const optButtons = buttons.filter((b) => OPTS.some((o) => b.text === o || b.text.includes(o)));
  console.log("ALL_BUTTON_COUNT", buttons.length);
  console.log("OPTION_BUTTONS", JSON.stringify(optButtons));
  // Also dump any data-testid=prompt-body text.
  const prompt = await pg.$$eval("[data-testid=prompt-body]", (ps) => ps.map((p) => p.innerText.trim())).catch(() => []);
  console.log("PROMPT_BODIES", JSON.stringify(prompt));
  fs.writeFileSync(`${OUT}/dom-full.html`, await pg.content());
  await browser.close();
})();
