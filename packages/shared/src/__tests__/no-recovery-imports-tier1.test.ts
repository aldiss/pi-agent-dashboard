/**
 * SEAM-2 one-way-dependency lint (design v0.3 Tier-1 §"Additive-safety on the
 * never-drop core" — the SEAM-2 structural rule). Sister to
 * `no-direct-process-kill.test.ts` / `no-raw-node-import.test.ts`.
 *
 * THE INVARIANT. The Tier-1 read packages are ABSENT from the recovery
 * dependency graph. The RECOVERY path — the code that DECIDES and ENACTS
 * never-drop re-delivery / terminalization / fail-loud — may NEVER import a
 * Tier-1 READER (a `thread-durability/tier1/…` module). No shared
 * "load-or-reconstruct" helper is allowed to bridge them.
 *
 * WHY it must be structural. Tier-1 is a read-only projection that confers NO
 * recovery/dedup/terminal authority (§"What Tier-1 is NOT"). If a recovery
 * module could import a Tier-1 reader, a future edit could quietly route a
 * recovery DECISION through a read projection — making the projection
 * load-bearing for correctness, exactly the coupling Tier-1's additive-safety
 * guarantee forbids. A type can't express "these modules never depend on those";
 * a lint can. The dependency stays one-way: readers may (eventually) read what
 * recovery produced, recovery never reads through a reader.
 *
 * THE CHECK. For each recovery module (asserted to exist, so a rename can't
 * silently void the guard), scan its `import`/`export … from`/dynamic-`import()`
 * specifiers and FAIL on any that resolves into a `thread-durability/tier1/`
 * path (relative, or via the shared package's `…/thread-durability/tier1/…`
 * subpath). The reverse direction is unconstrained.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";

/**
 * The recovery path — the modules that own the never-drop DECISION + its
 * enactment (re-deliver / terminalize / fail-loud / drain-to-holder). Paths are
 * repo-root-relative. Each MUST exist (asserted below) so a future rename
 * surfaces here instead of silently disabling the guard.
 */
const RECOVERY_MODULES: readonly string[] = [
  // The pure §C3.2 recovery decision table (shared).
  "packages/shared/src/thread-durability/recovery-decision.ts",
  // The bridge recovery-scan evidence resolver (exact-death scan + liveness).
  "packages/extension/src/thread-durability/recover-evidence.ts",
  // The injection primitive — the executing sequence recovery re-drives.
  "packages/extension/src/thread-durability/inject.ts",
  // The server drain loop — routes/re-attempts READY rows (never-drop enactment).
  "packages/server/src/thread-durability/drain-loop.ts",
  // The server durable store — owns recover()/reconcileAccepted() (the writes).
  "packages/server/src/thread-durability/outbox-store.ts",
];

/**
 * Detects an import/export/dynamic-import specifier that reaches a Tier-1
 * reader. Keys on `tier1` as a PATH SEGMENT — matching both shapes a recovery
 * module could use:
 *   - a relative sibling import (the recovery module already lives inside
 *     `thread-durability/`, so a tier1 reader is `./tier1/…` or `../tier1/…`),
 *   - the shared package subpath (`@…/thread-durability/tier1/…`).
 * The `(?:^|\/)tier1\/` anchor requires `tier1` to follow a path separator (or
 * start), so `some-tier1-thing` is NOT a false positive — only a real `tier1/`
 * directory segment matches. The Tier-1 readers are the only `tier1/` dirs in
 * the tree, so any such import from a recovery module is a genuine violation.
 */
const TIER1_SPECIFIER_RE = /(?:^|\/)tier1\//;

/** Extract every module specifier from `import`/`export … from`/`import()`. */
function moduleSpecifiers(source: string): string[] {
  const specs: string[] = [];
  // static `import … from "x"` and `export … from "x"`
  const staticRe = /\b(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/g;
  // side-effect `import "x"`
  const bareRe = /\bimport\s*["']([^"']+)["']/g;
  // dynamic `import("x")`
  const dynRe = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const re of [staticRe, bareRe, dynRe]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) specs.push(m[1]!);
  }
  return specs;
}

describe("SEAM-2: recovery path never imports a Tier-1 reader", () => {
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, "..", "..", "..", "..");

  it("every listed recovery module exists (a rename must not void the guard)", async () => {
    const missing: string[] = [];
    for (const rel of RECOVERY_MODULES) {
      try {
        await fs.access(path.resolve(repoRoot, rel));
      } catch {
        missing.push(rel);
      }
    }
    expect(
      missing,
      `SEAM-2 recovery modules not found (update RECOVERY_MODULES if intentionally renamed):\n` +
        missing.map((m) => `  ${m}`).join("\n"),
    ).toEqual([]);
  });

  it("no recovery module imports a thread-durability/tier1 reader", async () => {
    const violations: Array<{ file: string; line: number; spec: string }> = [];
    for (const rel of RECOVERY_MODULES) {
      const abs = path.resolve(repoRoot, rel);
      let content: string;
      try {
        content = await fs.readFile(abs, "utf-8");
      } catch {
        continue; // existence is asserted by the sibling test
      }
      for (const spec of moduleSpecifiers(content)) {
        if (!TIER1_SPECIFIER_RE.test(spec)) continue;
        // Compute a line number for the offending specifier.
        const idx = content.indexOf(spec);
        const line = idx < 0 ? 0 : content.slice(0, idx).split(/\r?\n/).length;
        violations.push({ file: rel, line, spec });
      }
    }

    if (violations.length > 0) {
      const msg =
        `SEAM-2 VIOLATION: a recovery module imports a Tier-1 reader.\n` +
        `The Tier-1 read packages must stay ABSENT from the recovery dependency\n` +
        `graph — recovery may never read through a read-only projection, and no\n` +
        `"load-or-reconstruct" helper may bridge them. Remove the import; keep the\n` +
        `dependency one-way (readers read what recovery produced, never the reverse).\n\n` +
        `Offenders (${violations.length}):\n` +
        violations.map((v) => `  ${v.file}:${v.line}  imports "${v.spec}"`).join("\n");
      expect(violations, msg).toEqual([]);
    }
  });

  it("the lint actually fires on a tier1 specifier (guard self-test)", () => {
    // Positive control: the detector must catch each shape it claims to.
    expect(
      moduleSpecifiers(`import { x } from "./tier1/thread-status-read.js";`).some((s) =>
        TIER1_SPECIFIER_RE.test(s),
      ),
    ).toBe(true);
    expect(
      moduleSpecifiers(
        `import { y } from "@blackbelt-technology/pi-dashboard-shared/thread-durability/tier1/index.js";`,
      ).some((s) => TIER1_SPECIFIER_RE.test(s)),
    ).toBe(true);
    expect(
      moduleSpecifiers(`const m = await import("../thread-durability/tier1/ledger-range.js");`).some(
        (s) => TIER1_SPECIFIER_RE.test(s),
      ),
    ).toBe(true);
    // And it must NOT fire on a normal thread-durability core import.
    expect(
      moduleSpecifiers(
        `import { decideRecovery } from "@blackbelt-technology/pi-dashboard-shared/thread-durability/index.js";`,
      ).some((s) => TIER1_SPECIFIER_RE.test(s)),
    ).toBe(false);
  });
});
