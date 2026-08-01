import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isDashboardBridge, planPackages, dashboardExtIdentity } from "./deploy.mjs";

/**
 * dl-13727 — bridge-pruner canonical-identity recognition (5 controls).
 *
 * The pre-fix predicate recognized a dashboard bridge ONLY by path substring
 * ("pi-agent-dashboard" / "pi-dashboard-prod"). A stale July-26 bridge under
 * /private/tmp/... contained neither, so registerBridge never pruned it and
 * sessions kept loading the pre-receipt tool. The fix recognizes by CANONICAL
 * PACKAGE IDENTITY (package.json name === "@blackbelt-technology/pi-dashboard-extension"),
 * authoritative for existing paths, with the legacy substring heuristic as a
 * fallback ONLY for missing/unreadable paths.
 *
 * RED BASELINE (able-to-fail): against the PRE-fix substring-only predicate,
 * control #1 (stale pruned) FAILS — the /tmp stale path is not recognized as a
 * dashboard bridge, so it is neither removed nor superseded. This suite is GREEN
 * only with the identity-first predicate. (A local `preFixIsDashboardBridge`
 * mirrors the old logic to prove control #1 is genuinely able-to-fail.)
 */

const CANON = "@blackbelt-technology/pi-dashboard-extension";
const OTHER = "@blackbelt-technology/some-other-extension";

let root; // throwaway temp root holding all fixtures
let TMP_STALE_ext; // stale bridge under /tmp-style root, canonical identity
let REL211_ext;    // the release target, canonical identity
let OTHER_ext;     // a DIFFERENT package at packages/extension (identity 'no')
const WORKFLOWS = "npm:@earendil-works/pi-workflows"; // unrelated preserved entry
let MISSING_LEGACY_HIT;  // missing path WITH "pi-agent-dashboard" substring
let MISSING_LEGACY_MISS; // missing path WITHOUT either substring

// Build packages/extension/package.json with a given name under <base>.
function seedExt(base, name) {
  const ext = join(base, "packages", "extension");
  mkdirSync(ext, { recursive: true });
  writeFileSync(join(ext, "package.json"), JSON.stringify({ name }, null, 2) + "\n");
  return ext;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "dl13727-"));
  // Model the real defect: the stale bridge lives under a /tmp-style dir with NO
  // "pi-agent-dashboard"/"pi-dashboard-prod" substring, yet declares the canonical name.
  TMP_STALE_ext = seedExt(join(root, "build1-pw-20260726", "dashboard", "release"), CANON);
  REL211_ext = seedExt(join(root, "pi-dashboard-prod", "releases", "sha211"), CANON);
  OTHER_ext = seedExt(join(root, "some-other-tree"), OTHER);
  // Missing paths (never created on disk) — identity is 'unknown' -> legacy fallback.
  MISSING_LEGACY_HIT = join(root, "gone", "pi-agent-dashboard", "packages", "extension");
  MISSING_LEGACY_MISS = join(root, "gone", "mystery-tool", "packages", "extension");
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

// The PRE-fix predicate (substring-only) — used to prove control #1 is able-to-fail.
function preFixIsDashboardBridge(p) {
  return (
    typeof p === "string" &&
    (p.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(p)) &&
    /packages[\\/]extension\/?$/.test(p) &&
    (p.includes("pi-agent-dashboard") || p.includes("pi-dashboard-prod"))
  );
}

describe("dashboardExtIdentity (yes/no/unknown)", () => {
  it("returns 'yes' for a canonical-name package.json", () => {
    expect(dashboardExtIdentity(TMP_STALE_ext)).toBe("yes");
    expect(dashboardExtIdentity(REL211_ext)).toBe("yes");
  });
  it("returns 'no' for a DIFFERENT package name", () => {
    expect(dashboardExtIdentity(OTHER_ext)).toBe("no");
  });
  it("returns 'unknown' for a missing/unreadable path", () => {
    expect(dashboardExtIdentity(MISSING_LEGACY_HIT)).toBe("unknown");
    expect(dashboardExtIdentity(MISSING_LEGACY_MISS)).toBe("unknown");
  });
});

describe("bridge pruner — 5 controls (dl-13727)", () => {
  it("[control 1: stale pruned] planPackages removes the stale /tmp canonical bridge, keeps the release target", () => {
    const pkgs = [WORKFLOWS, TMP_STALE_ext];
    const { kept, removed } = planPackages(pkgs, REL211_ext);
    expect(removed).toContain(TMP_STALE_ext);      // the exact stale path pruned
    expect(kept).not.toContain(TMP_STALE_ext);     // and excluded from kept
    expect(kept).toContain(REL211_ext);            // target present

    // ── able-to-fail proof: the PRE-fix substring predicate does NOT recognize
    //    the /tmp stale path, so it would NEVER be pruned (control #1 RED). ──
    expect(preFixIsDashboardBridge(TMP_STALE_ext)).toBe(false); // pre-fix blind spot
    expect(isDashboardBridge(TMP_STALE_ext)).toBe(true);        // fixed: identity recognizes it
  });

  it("[control 2: target retained exactly once] whether absent, present, or duplicated in input", () => {
    // absent
    expect(planPackages([WORKFLOWS], REL211_ext).kept.filter((x) => x === REL211_ext).length).toBe(1);
    // already present
    expect(planPackages([REL211_ext, WORKFLOWS], REL211_ext).kept.filter((x) => x === REL211_ext).length).toBe(1);
    // duplicated
    expect(planPackages([REL211_ext, REL211_ext, WORKFLOWS], REL211_ext).kept.filter((x) => x === REL211_ext).length).toBe(1);
  });

  it("[control 3: different-package + workflows preserved] identity 'no' and non-bridge entries stay", () => {
    const pkgs = [WORKFLOWS, OTHER_ext, TMP_STALE_ext];
    const { kept, removed } = planPackages(pkgs, REL211_ext);
    expect(kept).toContain(OTHER_ext);       // a DIFFERENT package -> preserved
    expect(kept).toContain(WORKFLOWS);       // an unrelated npm entry -> preserved
    expect(removed).not.toContain(OTHER_ext);
    expect(removed).not.toContain(WORKFLOWS);
    expect(removed).toContain(TMP_STALE_ext); // only the stale canonical bridge is pruned
  });

  it("[control 4: missing legacy handled] missing WITH substring pruned via fallback; missing WITHOUT preserved", () => {
    // identity 'unknown' for both -> legacy substring fallback decides.
    expect(isDashboardBridge(MISSING_LEGACY_HIT)).toBe(true);   // pruned via fallback
    expect(isDashboardBridge(MISSING_LEGACY_MISS)).toBe(false); // cannot be identified -> preserved

    const pkgs = [WORKFLOWS, MISSING_LEGACY_HIT, MISSING_LEGACY_MISS];
    const { kept, removed } = planPackages(pkgs, REL211_ext);
    expect(removed).toContain(MISSING_LEGACY_HIT);
    expect(kept).toContain(MISSING_LEGACY_MISS);
    expect(kept).not.toContain(MISSING_LEGACY_HIT);
  });

  it("[control 5: idempotent] feeding planPackages output back in leaves it unchanged", () => {
    const pkgs = [WORKFLOWS, OTHER_ext, TMP_STALE_ext, MISSING_LEGACY_HIT, MISSING_LEGACY_MISS];
    const first = planPackages(pkgs, REL211_ext);
    const second = planPackages(first.kept, REL211_ext);
    expect(second.kept).toEqual(first.kept);                              // stable
    expect(second.removed).toEqual([]);                                   // nothing left to prune
    expect(second.kept.filter((x) => x === REL211_ext).length).toBe(1);   // target still exactly once
  });
});
