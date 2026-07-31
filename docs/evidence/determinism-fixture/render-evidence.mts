/**
 * RENDER-EVIDENCE HARNESS (frozen evidence — amended code commit 8c2f649).
 *
 * Renders the REAL <DeterminismOverlay/> for the 3 frozen-fixture cases via
 * react-dom/server (projections loaded through the shared fs loader — the same
 * bind target the tests use), wraps the markup in the actual dark-theme CSS
 * tokens, and screenshots it with Playwright at mobile (393px) + desktop
 * (1440px). Proves the overlay renders — never a self-report.
 *
 * REPRODUCE (from repo root): esbuild-bundle with the @mdi/react shim, then run —
 *   npx esbuild docs/evidence/determinism-fixture/render-evidence.mts --bundle \
 *     --platform=node --format=esm --outfile=/tmp/render-evidence.bundle.mjs \
 *     --jsx=automatic --loader:.tsx=tsx --loader:.ts=ts \
 *     --alias:@mdi/react=./docs/evidence/determinism-fixture/mdi-react-shim.mjs \
 *     --packages=external --external:@mdi/react
 *   node /tmp/render-evidence.bundle.mjs
 * (the bundle is derived/regenerable and intentionally NOT committed).
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DeterminismOverlay } from "../../../packages/client/src/components/DeterminismOverlay.js";
import { loadDeterminismProjectionMap } from "../../../packages/shared/src/thread-durability/tier1/determinism-fixture.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const byId = loadDeterminismProjectionMap();
const samples = [...byId.values()];

// Identify the 3 cases by SHAPE (not pinned stage), matching the tests.
const multiEdge = samples.find((p) => p.pending.length >= 7)!;
const emptyPending = samples.find((p) => p.stage !== null && p.degrade !== "unmapped" && p.pending.length === 0)!;
const unmapped = samples.find((p) => p.degrade === "unmapped")!;

const CASES = [
  { title: "running · 7 pending · spine-only", p: multiEdge },
  { title: "done · empty pending (partial fold — NOT terminal)", p: emptyPending },
  { title: "unmapped · not in machine", p: unmapped },
];

// Dark-theme tokens (verbatim from packages/client/src/index.css :root).
const THEME_VARS = `
  --bg-primary:#0a0a0a; --bg-secondary:#141414; --bg-tertiary:#1e1e1e; --bg-surface:#2a2a2a;
  --text-primary:#e5e5e5; --text-secondary:#b0b0b0; --text-muted:#585858;
  --border-secondary:#333333;
  --accent-blue:#3b82f6; --accent-green:#22c55e; --accent-red:#ef4444; --accent-orange:#f97316;
  --font-mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
`;

const sections = CASES.map(
  ({ title, p }) => `
    <div style="display:flex;flex-direction:column;gap:8px;">
      <div style="font:600 11px/1.4 system-ui;color:var(--text-muted);text-transform:uppercase;letter-spacing:.08em;">${title}</div>
      <div style="max-width:520px;">${renderToStaticMarkup(React.createElement(DeterminismOverlay, { projection: p }))}</div>
    </div>`,
).join("\n");

const html = `<!doctype html><html><head><meta charset="utf-8">
<style>
  *{box-sizing:border-box;} .rounded-lg{border-radius:8px;} .rounded-md{border-radius:6px;} .rounded-full{border-radius:9999px;}
  .rounded{border-radius:4px;} .border{border-width:1px;border-style:solid;} .flex{display:flex;} .flex-col{flex-direction:column;}
  .items-center{align-items:center;} .items-start{align-items:flex-start;} .self-start{align-self:flex-start;}
  .gap-1{gap:4px;} .gap-1\\.5{gap:6px;} .gap-2{gap:8px;} .gap-3{gap:12px;} .flex-1{flex:1 1 0%;}
  .px-1{padding:0 4px;} .px-1\\.5{padding:0 6px;} .px-2{padding:0 8px;} .px-3{padding:0 12px;}
  .py-0\\.5{padding:2px 0;} .py-1{padding:4px 0;} .py-1\\.5{padding:6px 0;} .py-2\\.5{padding:10px 0;}
  .font-semibold{font-weight:600;} .font-bold{font-weight:700;} .font-medium{font-weight:500;}
  .uppercase{text-transform:uppercase;} .tracking-wide{letter-spacing:.025em;} .tracking-wider{letter-spacing:.05em;}
  .truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;} .whitespace-nowrap{white-space:nowrap;}
  .inline-flex{display:inline-flex;} ul{margin:0;padding:0;list-style:none;} li{list-style:none;}
  .leading-snug{line-height:1.375;} p{margin:0;} svg{display:inline-block;vertical-align:middle;}
  body{margin:0;padding:24px;background:var(--bg-primary);font-family:system-ui,sans-serif;}
</style></head>
<body style="${THEME_VARS.replace(/\n\s*/g, "")}">
  <div style="display:flex;flex-direction:column;gap:24px;max-width:560px;">
    <h1 style="font:700 14px/1.4 system-ui;color:var(--text-primary);margin:0;">DeterminismOverlay — 3 frozen-fixture cases (dark theme)</h1>
    ${sections}
  </div>
</body></html>`;

const htmlPath = path.join(HERE, "determinism-overlay-render.html");
fs.writeFileSync(htmlPath, html);
console.log("wrote", htmlPath);

const browser = await chromium.launch();
for (const [label, width, height] of [["mobile", 393, 852], ["desktop", 1440, 900]] as const) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
  await page.goto("file://" + htmlPath);
  await page.waitForTimeout(150);
  const out = path.join(HERE, `determinism-overlay-${label}.png`);
  await page.screenshot({ path: out, fullPage: true });
  console.log("screenshot", out);

  // DOM assertions on the RENDERED page (behavior, not just layout).
  const edgeCount = await page.locator('[data-testid="determinism-edge"]').count();
  const reapedCount = await page.locator('[data-testid="determinism-edge"][data-to="reaped"]').count();
  const unmappedShown = await page.locator('[data-testid="determinism-unmapped"]').count();
  const noEdgesShown = await page.locator('[data-testid="determinism-no-edges"]').count();
  const partialFold = await page.locator('[data-testid="determinism-degrade-badge"]').count();
  console.log(`[${label}] edges=${edgeCount} reaped=${reapedCount} unmapped=${unmappedShown} emptyPending=${noEdgesShown} partialFold=${partialFold}`);
  await page.close();
}
await browser.close();
console.log("done");
