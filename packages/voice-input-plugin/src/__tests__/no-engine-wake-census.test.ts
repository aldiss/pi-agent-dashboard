// @vitest-environment node
/**
 * CENSUS GUARD — the voice plugin spawns no processes and carries no engine-wake.
 *
 * Two facts this locks down, both of which were true only by accident before:
 *
 *  1. ZERO `wakeEngine`. The server once woke the append engine itself. That hop
 *     was withdrawn (it fired from a pane-blind route), leaving `wakeEngine` as
 *     an exported function with no callers — dead code that a later edit could
 *     re-wire without anyone noticing, restoring automatic engine invocation the
 *     operator never re-authorized. The engine is invoked by the recorder, never
 *     by the server.
 *
 *  2. ZERO direct `node:child_process`. The dead function was the only reason the
 *     plugin imported `spawn`, and that import violated the repo-wide allowlist
 *     (packages/shared no-direct-child-process). It failed the canonical deploy
 *     gate; hand-rolled deploys had been bypassing that gate, so the violation
 *     sat live and unseen.
 *
 * This is a CENSUS over the real source tree, not a hardcoded expectation: it
 * walks every .ts/.tsx under the plugin and reports offenders with file:line, so
 * it fails on a reintroduction anywhere, including in a file that does not exist
 * yet.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_SRC = fileURLToPath(new URL("..", import.meta.url));
const THIS_FILE = fileURLToPath(import.meta.url);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === "dist") continue;
      sourceFiles(full, out);
      continue;
    }
    if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

interface Offender {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

function scan(pattern: RegExp): Offender[] {
  const offenders: Offender[] = [];
  for (const file of sourceFiles(PLUGIN_SRC)) {
    // This guard necessarily names the forbidden tokens; exclude only itself.
    if (file === THIS_FILE) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((text, i) => {
      if (pattern.test(text)) {
        offenders.push({ file: relative(PLUGIN_SRC, file), line: i + 1, text: text.trim() });
      }
    });
  }
  return offenders;
}

describe("voice plugin census — no engine-wake, no process spawning", () => {
  it("finds source files to scan (the census is not vacuously empty)", () => {
    // A census that walked nothing would report zero offenders and look clean.
    const files = sourceFiles(PLUGIN_SRC).filter((f) => f !== THIS_FILE);
    expect(files.length).toBeGreaterThan(5);
    expect(files.some((f) => f.endsWith("spool-emit.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith(join("server", "index.ts")))).toBe(true);
  });

  it("has ZERO references to wakeEngine anywhere in the plugin", () => {
    const offenders = scan(/\bwakeEngine\b/);
    expect(
      offenders,
      `wakeEngine reintroduced:\n${offenders
        .map((o) => `  ${o.file}:${o.line}  ${o.text}`)
        .join("\n")}\nThe server must never invoke the append engine; the recorder does.`,
    ).toEqual([]);
  });

  it("has ZERO direct node:child_process imports in the plugin", () => {
    const offenders = scan(/from\s+["']node:child_process["']|require\(\s*["']node:child_process["']\s*\)/);
    expect(
      offenders,
      `direct child_process import reintroduced:\n${offenders
        .map((o) => `  ${o.file}:${o.line}  ${o.text}`)
        .join("\n")}\nUse @blackbelt-technology/pi-dashboard-shared/platform/exec.js.`,
    ).toEqual([]);
  });

  it("has ZERO bare 'child_process' imports either (the un-prefixed specifier)", () => {
    const offenders = scan(/from\s+["']child_process["']|require\(\s*["']child_process["']\s*\)/);
    expect(offenders).toEqual([]);
  });

  it("spawns nothing: no spawn/exec/fork call sites in the plugin", () => {
    const offenders = scan(/\b(spawnSync|execSync|execFileSync|spawn|execFile|fork)\s*\(/);
    expect(
      offenders,
      `process-spawning call site found:\n${offenders
        .map((o) => `  ${o.file}:${o.line}  ${o.text}`)
        .join("\n")}`,
    ).toEqual([]);
  });
});
