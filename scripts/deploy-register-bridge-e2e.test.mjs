import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync,
  realpathSync, existsSync, statSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Gap 2 (dl-13803 + dl-13808) — end-to-end `--register-bridge-only` integration.
 *
 * Exercises the REAL registerBridge settings read/write path (not just the pure
 * helpers) against a THROWAWAY temp HOME. registerBridge derives its settings
 * path from homedir(), so setting HOME in the child controls it — the operator's
 * real ~/.pi/agent/settings.json is NEVER touched (asserted via mtime).
 *
 * Proves: stale canonical bridge pruned; release extension present EXACTLY ONCE
 * (realpath-normalized target); unrelated packages preserved; non-dashboard
 * top-level keys byte-unchanged; release plugin-bridge pinned + stale dashboard-*
 * pruned; and a SECOND run is BYTE-IDENTICAL (idempotent).
 */

const DEPLOY_ABS = join(dirname(fileURLToPath(import.meta.url)), "deploy.mjs");
const CANON = "@blackbelt-technology/pi-dashboard-extension";
const REL_SHA = "e2edeadbeef0000000000000000000000000000ff";

const tmpDirs = [];
afterAll(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

function mkTemp(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

function seedExt(base, name) {
  const ext = join(base, "packages", "extension");
  mkdirSync(ext, { recursive: true });
  writeFileSync(join(ext, "package.json"), JSON.stringify({ name }, null, 2) + "\n");
  return ext;
}

// Build a temp HOME with a real prod-root release (canonical ext + a plugin that
// ships a dashboard-plugin manifest) + current symlink, a stale canonical bridge
// at a DIFFERENT temp root, and a seeded settings.json with unrelated state.
function seedWorld() {
  const home = mkTemp("e2e-home-");
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });

  // Real prod-root release tree.
  const prodRoot = join(home, ".pi-dashboard-prod");
  const releaseDir = join(prodRoot, "releases", REL_SHA);
  seedExt(releaseDir, CANON); // packages/extension/package.json (canonical)
  // A release plugin that ships a bridge manifest (mirrors registerBridge's D6 path).
  const pluginDir = join(releaseDir, "packages", "flows-anthropic-bridge-plugin");
  mkdirSync(join(pluginDir, "src", "bridge"), { recursive: true });
  writeFileSync(join(pluginDir, "package.json"), JSON.stringify({
    name: "flows-anthropic-bridge-plugin",
    "pi-dashboard-plugin": { id: "flows-anthropic-bridge", bridge: "./src/bridge/index.ts" },
  }, null, 2));
  writeFileSync(join(pluginDir, "src", "bridge", "index.ts"), "export default {};\n");
  symlinkSync(releaseDir, join(prodRoot, "current"));

  // Stale canonical bridge at a DIFFERENT temp root (models /private/tmp/build1-pw-*).
  const staleRoot = mkTemp("e2e-build1-pw-STALE-");
  const staleExt = seedExt(staleRoot, CANON);
  const stalePluginBridge = join(staleRoot, "packages", "flows-anthropic-bridge-plugin", "src", "bridge", "index.ts");

  // Unrelated (DIFFERENT package) bridge path that must be preserved.
  const otherRoot = mkTemp("e2e-other-");
  const otherExt = seedExt(otherRoot, "@blackbelt-technology/some-other-extension");

  // registerBridge realpaths current -> releaseDir, then joins packages/extension.
  const expectedTarget = join(realpathSync(join(prodRoot, "current")), "packages", "extension");
  const expectedPluginBridge = join(realpathSync(releaseDir), "packages", "flows-anthropic-bridge-plugin", "src", "bridge", "index.ts");

  const settings = {
    defaultProvider: "github-copilot",
    defaultModel: "claude-opus-4.8",
    thinking: "xhigh",
    packages: [staleExt, otherExt, "npm:something"],
    dashboardPluginBridges: {
      "dashboard-flows-anthropic-bridge": stalePluginBridge, // stale dashboard-* -> repinned to release
      "keepme": "/some/non-dashboard/bridge.ts",             // non-dashboard-* -> preserved verbatim
    },
  };
  const settingsPath = join(home, ".pi", "agent", "settings.json");
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");

  return { home, prodRoot, settingsPath, staleExt, otherExt, expectedTarget, expectedPluginBridge };
}

function runRegister(home, prodRoot) {
  return execFileSync("node", [DEPLOY_ABS, "--register-bridge-only", "--prod-root", prodRoot], {
    env: { ...process.env, HOME: home },
    encoding: "utf8",
    stdio: "pipe",
  });
}

describe("registerBridge end-to-end --register-bridge-only (dl-13803 / dl-13808)", () => {
  it("prunes the stale canonical bridge, keeps release once, preserves unrelated state, pins the release plugin-bridge", () => {
    const w = seedWorld();

    // Guard: capture the REAL operator settings mtime (must be untouched by this test).
    const realSettings = join(homedir(), ".pi", "agent", "settings.json");
    const realMtimeBefore = existsSync(realSettings) ? statSync(realSettings).mtimeMs : null;

    runRegister(w.home, w.prodRoot);
    const after = JSON.parse(readFileSync(w.settingsPath, "utf8"));

    // packages: stale pruned, release exactly once (realpath-normalized), unrelated preserved.
    expect(after.packages).not.toContain(w.staleExt);
    expect(after.packages.filter((p) => p === w.expectedTarget).length).toBe(1);
    expect(after.packages).toContain(w.otherExt);   // DIFFERENT package -> preserved
    expect(after.packages).toContain("npm:something");

    // non-dashboard top-level keys byte-unchanged.
    expect(after.defaultProvider).toBe("github-copilot");
    expect(after.defaultModel).toBe("claude-opus-4.8");
    expect(after.thinking).toBe("xhigh");

    // dashboardPluginBridges: release pinned, stale dashboard-* repinned to release, non-dashboard key preserved.
    expect(after.dashboardPluginBridges["dashboard-flows-anthropic-bridge"]).toBe(w.expectedPluginBridge);
    expect(after.dashboardPluginBridges["keepme"]).toBe("/some/non-dashboard/bridge.ts");

    // REAL operator settings untouched.
    const realMtimeAfter = existsSync(realSettings) ? statSync(realSettings).mtimeMs : null;
    expect(realMtimeAfter).toBe(realMtimeBefore);
  });

  it("is byte-idempotent: a SECOND --register-bridge-only run produces identical settings.json", () => {
    const w = seedWorld();
    runRegister(w.home, w.prodRoot);
    const firstBytes = readFileSync(w.settingsPath, "utf8");
    runRegister(w.home, w.prodRoot);
    const secondBytes = readFileSync(w.settingsPath, "utf8");

    expect(secondBytes).toBe(firstBytes); // byte-identical — no drift on re-run

    const after = JSON.parse(secondBytes);
    expect(after.packages.filter((p) => p === w.expectedTarget).length).toBe(1); // still exactly once
    expect(after.packages).not.toContain(w.staleExt);                            // still absent
    expect(after.packages).toContain(w.otherExt);                                // still preserved
    expect(after.dashboardPluginBridges["keepme"]).toBe("/some/non-dashboard/bridge.ts");
  });
});
