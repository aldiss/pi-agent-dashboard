import { defineConfig } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Isolated MobileComposer interaction e2e — regression guard for the ChatGPT-style column
 * layout (single-row -> column restructure; branch composer-chatgpt-multiline).
 *
 * Serves a standalone harness (packages/client/src/__e2e__/composer-harness.html) via the
 * client Vite on a SPARE port — NO live backend, NO real message sends. The harness mounts
 * MobileComposer with spy handlers on window.__e2e so the spec asserts REAL behavior:
 * typed-grow, the 200px scroll cap, the +/mic/Stop/Send handlers firing, the pointer-events
 * hit-test (the full-width text row must not intercept taps meant for the controls row),
 * and Enter-inserts-newline-not-send.
 *
 * Run: npm run test:e2e:composer
 */
const PORT = Number(process.env.COMPOSER_E2E_PORT || 5273);
const here = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(here, "../../packages/client");

export default defineConfig({
  testDir: "./specs",
  outputDir: path.resolve(here, "test-results"),
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    browserName: "chromium",
    viewport: { width: 390, height: 740 },
    actionTimeout: 10_000,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `../../node_modules/.bin/vite --port ${PORT} --strictPort --host 127.0.0.1`,
    cwd: clientDir,
    url: `http://127.0.0.1:${PORT}/__e2e__/composer-harness.html`,
    reuseExistingServer: true,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
