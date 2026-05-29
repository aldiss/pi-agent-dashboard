import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright iPhone-Safari emulation harness for ui-scroll-regression-hardening/v1 cell.
 *
 * Purpose: empirical-cycle-pass verifier per AGENTS.md v2.0 Mega-Cluster M tier-(a) discipline
 * for ChatView viewport-resize / orientation-change scroll-re-anchor behavior. PureYak's
 * uncommitted 88-line patch (packages/client/src/components/ChatView.tsx) + 4 vitest tests
 * (packages/client/src/components/__tests__/ChatView.viewport-resize-orientation.test.tsx)
 * verified in jsdom; THIS Playwright harness exercises real Chromium WebKit-ish browser
 * with iPhone 14 Pro Max device emulation against the LIVE dashboard at http://127.0.0.1:8000.
 *
 * Operator empirical bug verbatim per Pattern 87 byte-identical (preserve typos):
 *   "when i flip the screen from bertical to horizonataæ and back i end up in the midddle
 *    of the session and then has to scroll for a minite to actialæy go to the bottom"
 *
 * Tailscale Funnel proxies https://s-macbook-pro.tail954a35.ts.net/ → http://127.0.0.1:8000.
 *
 * HONEST CAVEATS:
 * - Playwright Chromium iPhone-emulation is NOT iOS Safari WebKit. visualViewport.resize
 *   timing + orientationchange behavior + scrollTop-preservation semantics may differ.
 *   qa/ios-visual/ has the canonical wdio+appium real-simulator harness as fallback if
 *   Playwright fidelity insufficient.
 * - This config targets http://127.0.0.1:8000 (live dashboard); for deterministic test
 *   isolation, fallback to qa/ios-visual fixture-launcher mode.
 */

const BASE_URL = process.env.PI_DASHBOARD_BASE_URL || "http://127.0.0.1:8000";

export default defineConfig({
  testDir: "./specs",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false, // sequential — tests interact with shared dashboard state
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },
  projects: [
    {
      name: "iphone-14-pro-max-portrait",
      use: {
        ...devices["iPhone 14 Pro Max"],
        // iPhone 14 Pro Max portrait: 430x932 viewport
        // EXPLICIT browser choice per GPT-5.5 cross-pair reviewer #2 concern
        // (W7 2026-05-29): devices["iPhone 14 Pro Max"] DEFAULTS to webkit per
        // Playwright canonical; we make it explicit here so the discipline is
        // self-documenting rather than implicit. WebKit IS the canonical iOS
        // Safari engine (not Chromium emulation); per Mega-Cluster M v2.0
        // tier-(b) extension #2 ANY-UI-commit-SHIP discipline, the canonical
        // browser for iPhone-empirical-cycle tests SHALL be WebKit.
        browserName: "webkit",
      },
    },
  ],
});
