import { defineConfig, devices } from "@playwright/test";

/**
 * Seeded-sandbox e2e config — the deterministic counterpart to
 * playwright.config.ts (which runs against the live :8000 and deliberately does
 * NOT snapshot the session list).
 *
 * This config boots a HOME-jailed, fixture-mode dashboard seeded from `seed/`
 * (via global-setup-sandbox.ts → the e2e-sandbox CLI) and points the specs at
 * it. Because the row-set is seeded + deterministic, the session-list specs can
 * assert exact UUIDs / statuses AND capture stable visual baselines — the
 * design-pass §3 "dashboard-mutation rows-render" headline (scenario S1).
 *
 * Run:
 *   npx playwright test --config e2e/playwright.sandbox.config.ts
 *   npx playwright test --config e2e/playwright.sandbox.config.ts --update-snapshots
 *
 * The sandbox falls back to 127.0.0.1:8100 when 127.0.0.2 is not bindable (macOS
 * without a sudo lo0 alias); override the port with E2E_SBX_PORT.
 */

const SBX_PORT = process.env.E2E_SBX_PORT || "8100";
const BASE_URL = process.env.PI_DASHBOARD_BASE_URL || `http://127.0.0.1:${SBX_PORT}`;

export default defineConfig({
  testDir: "./specs-sandbox",
  globalSetup: "./global-setup-sandbox.ts",
  snapshotPathTemplate: "{testDir}/__screenshots__/{testFilePath}/{arg}-{projectName}{ext}",
  timeout: 60_000,
  expect: {
    timeout: 10_000,
    // Same tolerance as the live suite — a real row-render regression moves far
    // more than 1.5% of pixels; sub-pixel font jitter stays under it.
    toHaveScreenshot: { maxDiffPixelRatio: 0.015, animations: "disabled" },
  },
  // Sequential — the seeded sandbox is a single shared instance.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report-sandbox" }]],
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
      use: { ...devices["iPhone 14 Pro Max"], browserName: "webkit" },
    },
    {
      name: "desktop-chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 }, browserName: "chromium" },
    },
  ],
});
