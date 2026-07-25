import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const bundledProducerWorktree = fileURLToPath(new URL(
  "./src/components/__tests__/fixtures/operator-voice",
  import.meta.url,
));

export default defineConfig({
  test: {
    include: ["src/**/__tests__/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    pool: "forks",
    maxWorkers: 1,
    globalSetup: ["@blackbelt-technology/pi-dashboard-shared/test-support/setup-home.ts"],
    env: {
      OPERATOR_VOICE_WORKTREE:
        process.env.OPERATOR_VOICE_WORKTREE ?? bundledProducerWorktree,
    },
  },
});
