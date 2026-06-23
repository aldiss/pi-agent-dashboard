import { defineConfig, devices } from "@playwright/test";

/**
 * Full-PWA end-to-end test framework for the pi-dashboard web client.
 *
 * This is the first-class PWA e2e net (the safety net for the Editorial Craft
 * redesign — §9 of the editorial-craft build brief). It promotes the proven
 * pattern from qa/playwright-mobile/playwright.config.ts to a general suite:
 *
 *   - iPhone 14 Pro Max (WebKit) — the REAL iOS-PWA target. The dashboard
 *     installs to the iOS home screen, so WebKit is the canonical engine
 *     (not Chromium emulation).
 *   - Desktop Chromium — the desktop happy path.
 *   - Desktop Safari (WebKit) — the operator's Mac-default engine.
 *
 * SERVER FIXTURE — v1 runs against the LIVE dashboard at :8000.
 *   The brief (§9.1) explicitly sanctions a documented run-against-live-:8000
 *   fallback for v1, exactly as qa/playwright-mobile does via
 *   PI_DASHBOARD_BASE_URL. We take that path here deliberately:
 *     1. The repo's working tree carries uncommitted WIP from OTHER lanes
 *        (server dirs + an auto-generated plugin-registry.tsx). A fresh
 *        `npm run build` would regenerate that file and clobber their work,
 *        so we MUST NOT rebuild/restart to stand up our own instance.
 *     2. The live :8000 already serves the committed editorial build, so the
 *        redesign-under-test is exactly what ships.
 *   A deterministic globalSetup that boots an ephemeral-port instance seeded
 *   from seed/ is the intended follow-up (flagged in e2e/README.md), not a v1
 *   blocker. globalSetup here just verifies the live server is reachable and
 *   fails fast with a clear message if it is not.
 */

const BASE_URL = process.env.PI_DASHBOARD_BASE_URL || "http://127.0.0.1:8000";

export default defineConfig({
  testDir: "./specs",
  globalSetup: "./global-setup.ts",
  // Visual-regression baselines live next to the specs, namespaced per project
  // (skin × theme × viewport galleries). Keeps the operator-facing gallery in
  // one place.
  snapshotPathTemplate: "{testDir}/__screenshots__/{testFilePath}/{arg}-{projectName}{ext}",
  timeout: 60_000,
  expect: {
    timeout: 10_000,
    // Tolerate sub-pixel font-rendering jitter between runs; a real skin
    // regression moves far more than 1.5% of pixels.
    toHaveScreenshot: { maxDiffPixelRatio: 0.015, animations: "disabled" },
  },
  // Sequential — every project drives the SAME shared live dashboard. Parallel
  // workers would race on session state + the singleton skin/theme attributes.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
  },
  projects: [
    {
      name: "iphone-14-pro-max",
      use: {
        // devices["iPhone 14 Pro Max"] defaults to webkit (the canonical iOS
        // Safari engine). We pin browserName explicitly so the discipline is
        // self-documenting — this is the real installed-PWA target.
        ...devices["iPhone 14 Pro Max"],
        browserName: "webkit",
      },
    },
    {
      name: "desktop-chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        browserName: "chromium",
      },
    },
    {
      name: "desktop-webkit",
      use: {
        ...devices["Desktop Safari"],
        viewport: { width: 1440, height: 900 },
        browserName: "webkit",
      },
    },
  ],
});
