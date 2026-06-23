/**
 * Two-load A/B: does an `immutable` Cache-Control header actually make a WebKit
 * browser SKIP the per-chunk revalidation requests on a warm reopen?
 *
 * Standalone (not part of the timeline spec) — drives one persistent context:
 *   load #1 (cold): populate HTTP cache
 *   load #2 (warm reopen): count how many /assets/* requests the browser still issues
 *
 * Baseline server (max-age=0) → browser re-requests all chunks (conditional GET → 304).
 * Patched server (immutable)  → browser issues ZERO /assets/* requests on load #2.
 *
 * Run against baseline vs patched via PI_DASHBOARD_BASE_URL; webkit project for iOS fidelity.
 * Diagnostic 2026-06-07 candidate-B behavioral proof. ALWAYS passes (diagnostic).
 */
import { test, expect, devices } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";

const BASE = process.env.PI_DASHBOARD_BASE_URL || "http://127.0.0.1:8001";
const LABEL = process.env.RUN_LABEL || "ab-headers";
const ARTIFACT_DIR =
  process.env.ARTIFACT_DIR ||
  path.resolve(process.env.HOME ?? "", ".pi/orchestration-state/_slow-load-diag-2026-06-07");

test.use({ ...devices["iPhone 14 Pro Max"], browserName: "webkit" });

test(`header-ab two-load reopen: ${LABEL}`, async ({ page }) => {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  // ── Load #1 (cold) — populate the HTTP cache ──
  const cold = { assetReqs: 0, assetBytes: 0 };
  const onReq1 = (resp: any) => {
    const u = resp.url();
    if (u.includes("/assets/")) {
      cold.assetReqs += 1;
    }
  };
  page.on("response", onReq1);
  await page.goto(`${BASE}/`, { waitUntil: "load", timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2500);
  page.off("response", onReq1);

  // ── Load #2 (warm reopen, same context = same HTTP cache) ──
  // Capture which /assets/* the browser RE-REQUESTS (network-level) + their status.
  const warm = { assetReqs: 0, statuses: {} as Record<string, number>, fromCache: 0 };
  const onReq2 = (resp: any) => {
    const u = resp.url();
    if (u.includes("/assets/")) {
      warm.assetReqs += 1;
      const s = String(resp.status());
      warm.statuses[s] = (warm.statuses[s] ?? 0) + 1;
    }
  };
  page.on("response", onReq2);
  const t0 = Date.now();
  await page.goto(`${BASE}/`, { waitUntil: "load", timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const warmLoadMs = Date.now() - t0;
  page.off("response", onReq2);

  const result = {
    label: LABEL,
    base: BASE,
    measuredAt: new Date().toISOString(),
    coldLoadAssetResponses: cold.assetReqs,
    warmReopenAssetResponses: warm.assetReqs,
    warmReopenStatusMix: warm.statuses,
    warmReopenLoadMs: warmLoadMs,
    interpretation:
      warm.assetReqs === 0
        ? "IMMUTABLE: browser issued ZERO /assets network responses on warm reopen (served from cache)"
        : `REVALIDATING: browser issued ${warm.assetReqs} /assets responses on warm reopen (status mix ${JSON.stringify(warm.statuses)})`,
  };
  const out = path.join(ARTIFACT_DIR, `header-ab__${LABEL}__${stamp}.json`);
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
  console.log("=== HEADER-AB RESULT ===");
  console.log(JSON.stringify(result, null, 2));
  console.log(`artifact: ${out}`);
  console.log("=== END ===");

  expect(true).toBe(true);
});
