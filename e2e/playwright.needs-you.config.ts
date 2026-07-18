import { defineConfig, devices } from "@playwright/test";

/**
 * Stage-6 E2E config for the "Needs you" band — SELF-CONTAINED.
 *
 * Unlike `playwright.config.ts` (which drives the shared live :8000), this boots
 * its OWN isolated server-under-test (real needs-you route + Vite-compiled real
 * client) via `needs-you-global-setup.ts`, on ports that never collide with
 * :8000/:3000. So it tests the band's route → component path deterministically,
 * driven by synthetic feeds — without touching any live instance or rebuilding.
 */

const HTTP_PORT = Number(process.env.NEEDS_YOU_E2E_PORT || 8137);

export default defineConfig({
  testDir: "./specs-needs-you",
  globalSetup: "./needs-you-global-setup.ts",
  timeout: 60_000,
  expect: { timeout: 12_000 },
  // Sequential — every spec drives the SAME shared harness + synthetic feed file.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${HTTP_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 12_000,
    navigationTimeout: 25_000,
  },
  projects: [
    {
      name: "iphone-14-pro-max",
      use: { ...devices["iPhone 14 Pro Max"], browserName: "webkit" },
    },
    {
      // iOS-viewport coverage on the CHROMIUM engine — the iPhone 14 Pro Max
      // device metrics (393×852, mobile, touch) with chromium. Used when the
      // bundled webkit engine can't launch on the host (a known env issue on
      // this box: webkit-2272 hangs on bare about:blank). Gives the real
      // iOS-width + touch responsive coverage via a working engine.
      name: "iphone-chromium",
      use: {
        ...devices["iPhone 14 Pro Max"],
        browserName: "chromium",
        defaultBrowserType: "chromium",
      },
    },
    {
      name: "desktop-chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 }, browserName: "chromium" },
    },
  ],
});
