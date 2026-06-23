import { defineConfig, devices } from "@playwright/test";

/**
 * Round-2 MULTI-DEVICE config — mobile-slow-load-diagnostic 2026-06-07.
 *
 * ISOLATED from playwright.config.ts (which Round 1 is actively using) so the two
 * rounds never collide. Same testDir/specs; broader device matrix per operator
 * wall-budget-extension canonical (8h floor): extend e2e to multiple device tiers.
 *
 * Device matrix rationale:
 *   - iphone-se-webkit       smallest/oldest-tier iPhone (375x667 dpr2) — worst-case iOS layout/CPU
 *   - iphone-14-pro-max-webkit  operator's ACTUAL device (430x932 portrait) — canonical reproduction
 *   - galaxy-s24-chromium    modern Android (chromium → CDP 3G+CPU throttle works here)
 *   - pixel-7-chromium       mid-tier Android (chromium → CDP throttle)
 *   - ipad-11-webkit         tablet webkit — larger viewport / different render path
 *
 * NET_PROFILE=3g (CDP throttle) only fires on the chromium-engine projects.
 * Run one device+scenario per invocation via env-vars (see mobile-slow-load-timeline.spec.ts).
 */
const BASE_URL = process.env.PI_DASHBOARD_BASE_URL || "http://127.0.0.1:8000";

export default defineConfig({
  testDir: "./specs",
  timeout: 120_000, // larger than default: heavy sessions + throttled runs + multi-iteration
  expect: { timeout: 15_000 },
  fullyParallel: false, // sequential — shared dashboard state + clean uncontended timing
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 60_000, // throttled 3G cold-load can be slow
  },
  projects: [
    {
      name: "iphone-se-webkit",
      use: { ...devices["iPhone SE (3rd gen)"], browserName: "webkit" },
    },
    {
      name: "iphone-14-pro-max-webkit",
      use: { ...devices["iPhone 14 Pro Max"], browserName: "webkit" },
    },
    {
      name: "galaxy-s24-chromium",
      use: { ...devices["Galaxy S24"], browserName: "chromium" },
    },
    {
      name: "pixel-7-chromium",
      use: { ...devices["Pixel 7"], browserName: "chromium" },
    },
    {
      name: "ipad-11-webkit",
      use: { ...devices["iPad (gen 11)"], browserName: "webkit" },
    },
  ],
});
