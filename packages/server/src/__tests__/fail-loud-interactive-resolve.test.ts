/**
 * Fix-10 — fail-loud when an interactive strategy can't resolve its tool.
 *
 * `selectMechanism` silently falls back to headless `--mode rpc` when
 * `strategy:tmux` is requested but tmux is unavailable. Headless `--mode rpc`
 * is the v1 crash-form on large logs — the exact thing un-end v2 replaced. A
 * session-RESUME (`requireInteractive:true`) that can't resolve its interactive
 * tool must FAIL-LOUD (`INTERACTIVE_UNAVAILABLE`), never silently degrade.
 *
 * See change: fail-loud-interactive-resolve.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolResolver } from "@blackbelt-technology/pi-dashboard-shared/platform/binary-lookup.js";
import {
  interactiveResolutionFailed,
  spawnPiSession,
  setResolver,
  resetResolver,
} from "../process-manager.js";

describe("Fix-10: interactiveResolutionFailed (pure guard)", () => {
  it("fails loud: requireInteractive + resolved headless (tool unavailable)", () => {
    expect(interactiveResolutionFailed("headless", true)).toBe(true);
  });

  it("passes: requireInteractive + resolved tmux", () => {
    expect(interactiveResolutionFailed("tmux", true)).toBe(false);
  });

  it("passes: requireInteractive + resolved wt", () => {
    expect(interactiveResolutionFailed("wt", true)).toBe(false);
  });

  it("passes: requireInteractive + resolved wsl-tmux", () => {
    expect(interactiveResolutionFailed("wsl-tmux", true)).toBe(false);
  });

  it("no-guard: headless without requireInteractive is allowed (fresh spawn)", () => {
    expect(interactiveResolutionFailed("headless", false)).toBe(false);
    expect(interactiveResolutionFailed("headless", undefined)).toBe(false);
  });
});

describe("Fix-10: spawnPiSession fail-loud gate", () => {
  afterEach(() => resetResolver());

  /** Resolver whose tmux/wt/wsl-tmux probes all miss → mechanism resolves headless. */
  function makeNoTmuxResolver(): ToolResolver {
    const r = new ToolResolver({ processExecPath: process.execPath });
    // Force every interactive-tool probe to miss. `which` is the seam used by
    // isTmuxAvailable / isWtAvailable inside chooseMechanism.
    (r as unknown as { which: (n: string) => string | null }).which = (name: string) => {
      if (name === "tmux" || name === "wt") return null;
      return "/usr/bin/" + name; // pi/node resolve fine — not the point of this test
    };
    return r;
  }

  it("REFUSES loud when requireInteractive + tmux unavailable (never silent headless)", async () => {
    setResolver(makeNoTmuxResolver());
    const cwd = mkdtempSync(join(tmpdir(), "fix10-loud-"));
    const result = await spawnPiSession(cwd, {
      sessionFile: join(cwd, "seed.jsonl"),
      mode: "continue",
      strategy: "tmux",
      requireInteractive: true,
    });
    expect(result.success).toBe(false);
    expect(result.code).toBe("INTERACTIVE_UNAVAILABLE");
    expect(result.message).toMatch(/interactive session-resume required/i);
    // Falsifiable: it must NOT have become a headless rpc spawn.
    expect(result.message).not.toMatch(/spawned headless/i);
  });

  it("does NOT refuse a fresh spawn (no requireInteractive) — graceful headless fallback stands", async () => {
    setResolver(makeNoTmuxResolver());
    const cwd = mkdtempSync(join(tmpdir(), "fix10-fresh-"));
    // No requireInteractive → the headless fallback is allowed. The spawn may
    // still fail later (no real pi in the isolated PATH) but it must NOT be the
    // fail-loud INTERACTIVE_UNAVAILABLE refusal — that's the falsifiable point.
    const result = await spawnPiSession(cwd, { strategy: "tmux" });
    expect(result.code).not.toBe("INTERACTIVE_UNAVAILABLE");
  });
});
