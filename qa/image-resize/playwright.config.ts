import { defineConfig } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Real-browser e2e for the pre-send image-resize layer.
 *
 * Serves a standalone harness (packages/client/src/__e2e__/image-resize-harness.html)
 * via the client Vite on a SPARE port — NO live backend. The harness exposes the REAL
 * resize module (canvasResizeBackend runs an actual <canvas> encode) on
 * window.__imageResizeE2E, so the spec exercises the exact browser path the jsdom unit
 * tests cannot: generate a real browser-encoded photo, run the production resize, decode
 * the result, and assert the 1568px long-edge cap + the payload shrink.
 *
 * Run: npm run test:e2e:image-resize
 */
const PORT = Number(process.env.IMAGE_RESIZE_E2E_PORT || 5274);
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
    actionTimeout: 10_000,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `../../node_modules/.bin/vite --port ${PORT} --strictPort --host 127.0.0.1`,
    cwd: clientDir,
    url: `http://127.0.0.1:${PORT}/__e2e__/image-resize-harness.html`,
    reuseExistingServer: true,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
