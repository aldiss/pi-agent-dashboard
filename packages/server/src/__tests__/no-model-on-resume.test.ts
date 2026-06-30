/**
 * Model-free resume/resurrect invariant (build-gate item 4; design-pass §3-D).
 *
 * The operator mandate's transport-restoration uses the §19 interactive form:
 * `PI_AGENT_NAME=<Name> pi --name <Name> --session <file>` — NO `--model`. The
 * `--model` arg is EXONERATED as the crash cause (design-pass §2), and the typed
 * dashboard spawn path never passes it. This test makes model-freeness
 * STRUCTURAL rather than a fake raw-args strip, in three layers:
 *
 *   (1) TYPE invariant — `SessionOptions` (process-manager) and `SessionFlags`
 *       (spawn-mechanism) carry no `model`/`modelId` field by construction, so a
 *       typed caller CANNOT add `--model` on a `--session` resume. Compile-time
 *       guard (fires under `tsc` / `reload:check`).
 *   (2) BEHAVIORAL invariant — the four argv builders never emit `--model`, even
 *       when handed a session file + continue/fork mode (+ an illicit `model`
 *       cast onto the options bag). Runtime-enforced by `npm test`.
 *   (3) GREP/repo-lint invariant — no source file that builds session-spawn argv
 *       (references `--session`/`--fork` or a spawn-arg builder) also constructs
 *       a `--model` token. Sister to `no-raw-node-import` / `no-direct-process-kill`.
 *       If a raw-args resume seam ever appears, this fails LOUD — forcing the
 *       author to either drop `--model` or consciously allowlist (design-pass
 *       §3-D: "IF a raw-args resume seam ever exists: strip + loud DEV-AUDIT log").
 *
 * See change: unend-mechanism-v2.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";
import {
  buildHeadlessArgs,
  buildInteractivePiArgs,
  buildTmuxCommand,
  type SessionOptions,
} from "../process-manager.js";
import {
  sessionFlagsToArgv,
  type SessionFlags,
} from "@blackbelt-technology/pi-dashboard-shared/platform/spawn-mechanism.js";

// ── (1) TYPE invariant (compile-time) ───────────────────────────────────────
// `"model" extends keyof T` collapses to `never` the moment a `model` key is
// added, so the `= true` assignment stops compiling. Belt-and-suspenders for
// `tsc`; the runtime layers below carry `npm test`.
type AssertNoModelKey<T> = "model" extends keyof T
  ? never
  : "modelId" extends keyof T
    ? never
    : true;

const _noModelOnSessionOptions: AssertNoModelKey<SessionOptions> = true;
const _noModelOnSessionFlags: AssertNoModelKey<SessionFlags> = true;
// Reference them so noUnusedLocals can't strip the guards.
void _noModelOnSessionOptions;
void _noModelOnSessionFlags;

describe("model-free resume/resurrect invariant (build-gate item 4)", () => {
  // ── (2) BEHAVIORAL invariant ───────────────────────────────────────────
  describe("argv builders never emit --model", () => {
    // An illicit options bag: a `model` field smuggled past the type system
    // via cast. The builders must STILL never surface it as an argv token —
    // they whitelist only sessionFile + mode through `sessionFlagsToArgv`.
    const illicit = {
      sessionFile: "/path/to/session.jsonl",
      mode: "continue" as const,
      model: "anthropic/claude-sonnet-4",
      modelId: "claude-sonnet-4",
    } as unknown as SessionOptions;

    it("buildHeadlessArgs(continue) → no --model", () => {
      const args = buildHeadlessArgs({ sessionFile: "/s.jsonl", mode: "continue" });
      expect(args).toContain("--session");
      expect(args).not.toContain("--model");
      expect(args.join(" ")).not.toMatch(/claude|sonnet|anthropic/i);
    });

    it("buildHeadlessArgs(illicit model cast) → no --model", () => {
      const args = buildHeadlessArgs(illicit);
      expect(args).not.toContain("--model");
      expect(args.join(" ")).not.toMatch(/claude|sonnet|anthropic/i);
    });

    it("buildInteractivePiArgs(continue) → --session but no --model", () => {
      const args = buildInteractivePiArgs({ sessionFile: "/s.jsonl", mode: "continue" });
      expect(args).toEqual(["--session", "/s.jsonl"]);
      expect(args).not.toContain("--model");
    });

    it("buildInteractivePiArgs(illicit model cast) → no --model", () => {
      const args = buildInteractivePiArgs(illicit);
      expect(args).not.toContain("--model");
    });

    it("buildTmuxCommand(continue) → no --model", () => {
      const cmd = buildTmuxCommand("/cwd", true, { sessionFile: "/s.jsonl", mode: "continue" });
      expect(cmd).toContain("--session /s.jsonl");
      expect(cmd).not.toContain("--model");
    });

    it("buildTmuxCommand(illicit model cast) → no --model", () => {
      const cmd = buildTmuxCommand("/cwd", true, illicit);
      expect(cmd).not.toContain("--model");
    });

    it("sessionFlagsToArgv(continue) → exactly [--session, file], no --model", () => {
      const argv = sessionFlagsToArgv({ sessionFile: "/s.jsonl", mode: "continue" });
      expect(argv).toEqual(["--session", "/s.jsonl"]);
    });

    it("sessionFlagsToArgv(fork) → exactly [--fork, file], no --model", () => {
      const argv = sessionFlagsToArgv({ sessionFile: "/s.jsonl", mode: "fork" });
      expect(argv).toEqual(["--fork", "/s.jsonl"]);
    });
  });

  // ── (3) GREP/repo-lint invariant ───────────────────────────────────────
  it("no session-spawn source file constructs a --model token", async () => {
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    // here = packages/server/src/__tests__ → repoRoot is four up.
    const repoRoot = path.resolve(here, "..", "..", "..", "..");
    const packagesDir = path.resolve(repoRoot, "packages");

    /**
     * Files allowed to reference `--model` even alongside session-spawn flags.
     * Empty today: the typed path never passes `--model`. A future
     * spawn-with-model feature would add its file here CONSCIOUSLY (the loud
     * decision the design wants) or use the per-line opt-out marker.
     */
    const ALLOWLIST: readonly string[] = [];
    const OPT_OUT_MARKER = "ban:model-on-resume-ok";

    // Markers that prove a file is on the session-spawn/resume code path. The
    // lint only fires for `--model` when one of these co-occurs — so an
    // unrelated future CLI that legitimately takes `--model` is not flagged.
    const SPAWN_PATH_MARKERS = [
      "--session",
      "--fork",
      "sessionFlagsToArgv",
      "buildHeadlessArgs",
      "buildInteractivePiArgs",
      "buildTmuxCommand",
      "spawnPiSession",
    ];

    const MODEL_TOKEN_RE = /["'`]--model\b/;

    async function* walk(dir: string): AsyncGenerator<string> {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (
            entry.name === "node_modules" ||
            entry.name === "dist" ||
            entry.name === "__tests__"
          )
            continue;
          yield* walk(full);
        } else if (entry.isFile() && /\.(ts|tsx|mts|cts)$/.test(entry.name)) {
          yield full;
        }
      }
    }

    const allowSet = new Set(
      ALLOWLIST.map((p) => path.resolve(repoRoot, p).replace(/\\/g, "/")),
    );

    const violations: Array<{ file: string; line: number; text: string }> = [];

    for (const pkg of await fs.readdir(packagesDir, { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue;
      const srcDir = path.join(packagesDir, pkg.name, "src");
      try {
        await fs.access(srcDir);
      } catch {
        continue;
      }
      for await (const file of walk(srcDir)) {
        const normalized = file.replace(/\\/g, "/");
        if (allowSet.has(normalized)) continue;

        const content = await fs.readFile(file, "utf-8");
        // Only files on the session-spawn path are candidates.
        if (!SPAWN_PATH_MARKERS.some((m) => content.includes(m))) continue;

        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!;
          if (!MODEL_TOKEN_RE.test(line)) continue;
          if (line.includes(OPT_OUT_MARKER)) continue;
          violations.push({
            file: path.relative(repoRoot, file),
            line: i + 1,
            text: line.trim(),
          });
        }
      }
    }

    if (violations.length > 0) {
      const msg =
        `A session-spawn/resume source file constructs a --model token.\n` +
        `The resume path is model-free by design (design-pass §3-D): the §19\n` +
        `interactive form is "PI_AGENT_NAME=<N> pi --name <N> --session <file>",\n` +
        `NO --model. Drop the --model arg, or — if this is an intentional\n` +
        `spawn-with-model seam — strip+loud-DEV-AUDIT-log it and add a per-line\n` +
        `"${OPT_OUT_MARKER}" marker or allowlist the file.\n\n` +
        `Offenders (${violations.length}):\n` +
        violations.map((v) => `  ${v.file}:${v.line}  ${v.text}`).join("\n");
      expect(violations, msg).toEqual([]);
    }
  });
});
