/**
 * Fix-11 — harden ALL default-headless pi-native session-RESUME paths.
 *
 * un-end v2 hardened only `/resurrect`. The silent-headless class is broad:
 * every path that resumes an existing `--session <file>` (the large-log crash
 * risk) used to spawn with `config.spawnStrategy` (default headless →
 * `--mode rpc` = the v1 crash-form). This suite pins:
 *
 *   (1) the shared §19 builder produces the hardened shape (tmux + fail-loud +
 *       pin + identity), and NEVER `--model`;
 *   (2) the pin resolver prefers the live bound socket over the config port;
 *   (3) STRUCTURAL repo-lint — every real session-RESUME call site funnels
 *       through `buildInteractiveResumeOptions`, so none can silently revert to
 *       `strategy: config.spawnStrategy` on a `--session`/`continue`/`fork` spawn.
 *
 * See change: harden-headless-resume-paths.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";
import {
  buildInteractiveResumeOptions,
  resolvePinDashboardUrl,
} from "../resume-spawn-options.js";

describe("Fix-11: buildInteractiveResumeOptions (§19 shape)", () => {
  it("continue → strategy tmux + requireInteractive, carries sessionFile+mode", () => {
    const opts = buildInteractiveResumeOptions({
      sessionFile: "/s/seed.jsonl",
      mode: "continue",
    });
    expect(opts.strategy).toBe("tmux");
    expect(opts.requireInteractive).toBe(true);
    expect(opts.sessionFile).toBe("/s/seed.jsonl");
    expect(opts.mode).toBe("continue");
  });

  it("fork → strategy tmux + requireInteractive + fork mode", () => {
    const opts = buildInteractiveResumeOptions({
      sessionFile: "/s/seed.jsonl",
      mode: "fork",
    });
    expect(opts.strategy).toBe("tmux");
    expect(opts.requireInteractive).toBe(true);
    expect(opts.mode).toBe("fork");
  });

  it("includes agentName + pin when provided (§19 identity + anti-cross-wire)", () => {
    const opts = buildInteractiveResumeOptions({
      sessionFile: "/s/seed.jsonl",
      mode: "continue",
      agentName: "Pete",
      pinDashboardUrl: "ws://localhost:9997",
    });
    expect(opts.agentName).toBe("Pete");
    expect(opts.pinDashboardUrl).toBe("ws://localhost:9997");
  });

  it("omits agentName + pin when absent (no empty flags)", () => {
    const opts = buildInteractiveResumeOptions({ sessionFile: "/s/seed.jsonl", mode: "continue" });
    expect("agentName" in opts).toBe(false);
    expect("pinDashboardUrl" in opts).toBe(false);
  });

  it("NEVER carries a model field (model-free resume invariant)", () => {
    const opts = buildInteractiveResumeOptions({
      sessionFile: "/s/seed.jsonl",
      mode: "continue",
      agentName: "Pete",
    }) as Record<string, unknown>;
    expect("model" in opts).toBe(false);
    expect("modelId" in opts).toBe(false);
    expect(JSON.stringify(opts)).not.toMatch(/--model|modelId/);
  });
});

describe("Fix-11: resolvePinDashboardUrl (runtime port, not config)", () => {
  it("prefers the live bound socket over the fallback port", () => {
    const url = resolvePinDashboardUrl({ address: () => 9997 }, 12345);
    expect(url).toBe("ws://localhost:9997");
  });

  it("falls back to serverPiPort when socket not bound", () => {
    const url = resolvePinDashboardUrl({ address: () => null }, 12345);
    expect(url).toBe("ws://localhost:12345");
  });

  it("undefined when neither resolvable (→ no pin, no crash)", () => {
    expect(resolvePinDashboardUrl({ address: () => null }, undefined)).toBeUndefined();
  });
});

// ── (3) STRUCTURAL repo-lint: every resume call site funnels through the builder ──
// The bug this guards: a real session-RESUME (loads --session <file>) that
// spawns with `strategy: config.spawnStrategy` silently defaults to the headless
// `--mode rpc` crash-form. After Fix-11, every such site MUST call
// `buildInteractiveResumeOptions`. This lint fails LOUD if a resume site is
// added/reverted that passes a raw `spawnStrategy`/`strategy` on a
// `mode: "continue"|"fork"` spawn without the builder.
describe("Fix-11: structural — resume sites use the hardened builder", () => {
  it("no resume call site passes a raw config strategy on a mode:continue/fork spawn", async () => {
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(here, "..", "..", "..", "..");
    const serverSrc = path.resolve(repoRoot, "packages", "server", "src");

    // The three converted real-resume sites (must reference the builder).
    const REQUIRED_BUILDER_SITES = [
      "session-api.ts",
      "browser-handlers/session-action-handler.ts",
    ];
    for (const rel of REQUIRED_BUILDER_SITES) {
      const content = await fs.readFile(path.join(serverSrc, rel), "utf-8");
      expect(
        content.includes("buildInteractiveResumeOptions"),
        `${rel} must route its session-RESUME spawn through buildInteractiveResumeOptions`,
      ).toBe(true);
    }

    // Belt: the builder file itself hard-codes the §19 shape.
    const builder = await fs.readFile(path.join(serverSrc, "resume-spawn-options.ts"), "utf-8");
    expect(builder).toMatch(/strategy:\s*"tmux"/);
    expect(builder).toMatch(/requireInteractive:\s*true/);
  });
});
