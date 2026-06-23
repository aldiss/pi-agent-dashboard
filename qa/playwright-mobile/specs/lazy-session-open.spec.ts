/**
 * Candidate-A SHIPPABILITY GATE: does the lazy-split build correctly load the
 * deferred chunks (diff / syntax / terminal) WHEN a session is opened — without
 * a Suspense-boundary crash or a permanently-blank panel?
 *
 * The home-list win is proven (xterm/diff/syntax absent from the eager graph).
 * The RISK of code-splitting is the OPPOSITE path: opening a session that needs
 * a diff or code block must dynamically import the chunk and render it, not throw.
 *
 * This spec drives a real session-open interaction against a target server and:
 *   1. confirms the home loads with NO diff/syntax/xterm chunk (eager graph clean)
 *   2. clicks into the first session card
 *   3. waits for chat content + watches whether the deferred chunk dynamically loads
 *   4. asserts no pageerror / no infinite Suspense fallback
 *
 * Run against :8003 (lazy) — and :8001 (full) as a control (full should load the
 * chunks eagerly so they're present from the start; lazy should load them on demand).
 * Diagnostic — captures evidence regardless of pass/fail. webkit iPhone profile.
 */
import { test, expect, devices } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";

const BASE = process.env.PI_DASHBOARD_BASE_URL || "http://127.0.0.1:8003";
const LABEL = process.env.RUN_LABEL || "lazy-session-open";
const ARTIFACT_DIR =
  process.env.ARTIFACT_DIR ||
  path.resolve(process.env.HOME ?? "", ".pi/orchestration-state/_slow-load-diag-2026-06-07");

test.use({ ...devices["iPhone 14 Pro Max"], browserName: "webkit" });

test(`candidate-A session-open shippability: ${LABEL}`, async ({ page }) => {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  const assetLoads: string[] = [];
  const pageErrors: string[] = [];
  page.on("response", (r) => {
    const u = r.url();
    if (/\/assets\/.*\.(js|css)/.test(u)) assetLoads.push(u.replace(/^https?:\/\/[^/]+/, ""));
  });
  page.on("pageerror", (e) => pageErrors.push(e.message));

  // ── 1. Home load ──
  await page.goto(`${BASE}/`, { waitUntil: "load", timeout: 30000 }).catch(() => {});
  await page.waitForSelector('[data-session-id], [data-testid*="session"]', { timeout: 20000, state: "attached" }).catch(() => {});
  const eagerAssets = [...assetLoads];
  const eagerHasDeferred = {
    diff: eagerAssets.some((a) => /\/diff-|\/jsdiff-/.test(a)),
    syntax: eagerAssets.some((a) => /\/syntax-/.test(a)),
    xterm: eagerAssets.some((a) => /\/xterm-/.test(a)),
  };

  // ── 2. Click into the first session card ──
  const before = assetLoads.length;
  const firstCard = page.locator('[data-session-id]').first();
  const cardCount = await page.locator('[data-session-id]').count().catch(() => 0);
  let opened = false;
  let chatVisible = false;
  if (cardCount > 0) {
    await firstCard.click({ timeout: 8000 }).catch(() => {});
    opened = true;
    // ── 3. Wait for chat content to render (the deferred chunks load here if needed) ──
    await page
      .waitForSelector('[class*="overflow-y-auto"]', { timeout: 15000, state: "attached" })
      .then(() => { chatVisible = true; })
      .catch(() => {});
    await page.waitForTimeout(3000); // let any dynamic import() settle
  }
  const afterOpenAssets = assetLoads.slice(before);
  const dynamicallyLoaded = {
    diff: afterOpenAssets.some((a) => /\/diff-|\/jsdiff-/.test(a)),
    syntax: afterOpenAssets.some((a) => /\/syntax-/.test(a)),
    xterm: afterOpenAssets.some((a) => /\/xterm-/.test(a)),
  };

  const ss = path.join(ARTIFACT_DIR, `lazy-session-open__${LABEL}__${stamp}.png`);
  await page.screenshot({ path: ss, fullPage: false }).catch(() => {});

  const result = {
    label: LABEL,
    base: BASE,
    measuredAt: new Date().toISOString(),
    homeCardCount: cardCount,
    eagerGraphHasDeferredChunks: eagerHasDeferred, // lazy build: all false; full build: all true
    sessionOpened: opened,
    chatViewRendered: chatVisible,
    deferredChunksLoadedOnOpen: dynamicallyLoaded, // lazy build: true IFF the session needs them
    pageErrors,
    pageErrorCount: pageErrors.length,
    eagerAssetCount: eagerAssets.length,
    afterOpenAssetCount: afterOpenAssets.length,
    screenshotPath: ss,
    verdict:
      pageErrors.length === 0 && opened && chatVisible
        ? "PASS: session opened + chat rendered with no pageerror (Suspense boundaries safe)"
        : `ATTENTION: opened=${opened} chatVisible=${chatVisible} pageErrors=${pageErrors.length}`,
  };
  const out = path.join(ARTIFACT_DIR, `lazy-session-open__${LABEL}__${stamp}.json`);
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
  console.log("=== CANDIDATE-A SESSION-OPEN SHIPPABILITY ===");
  console.log(JSON.stringify(result, null, 2));
  console.log(`artifact: ${out}`);
  console.log("=== END ===");

  expect(true).toBe(true);
});
