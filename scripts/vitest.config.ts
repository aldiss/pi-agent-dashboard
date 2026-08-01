import { defineConfig } from "vitest/config";

/**
 * Vitest project for scripts/ tests. Explicit include (not a glob) so ONLY the
 * vitest-style tests are swept in — the sibling `deploy-bridge-isolation.test.mjs`
 * is a standalone node script (run via `node scripts/deploy-bridge-isolation.test.mjs`)
 * and must NOT be collected by vitest.
 */
export default defineConfig({
  test: {
    include: [
      "deploy-bridge-registrar.test.mjs",
      "deploy-register-bridge-e2e.test.mjs",
    ],
    environment: "node",
    pool: "forks",
    maxWorkers: 1,
  },
});
