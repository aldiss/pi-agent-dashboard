/**
 * Pure classification + liveness predicates for external agent sessions.
 *
 * No I/O here — every function takes argv strings and returns a runtime|null
 * or a boolean, so they are unit-testable against fixture strings. The scanner
 * feeds these the argv it reads via `ps`.
 *
 * Why not reuse `platform/process-identify.ts#isPiCommandLine`: that matches
 * `\bpi\b|\bnode\b` — far too broad here, because a Codex pane's child argv is
 * `node /opt/homebrew/bin/codex --yolo` (contains `node`) and would be misread
 * as pi. We need a pi-SPECIFIC root check.
 */
import type { ExternalRuntime } from "@blackbelt-technology/pi-dashboard-shared/external-session.js";

const CODEX_RE = /\bcodex\b/;
const CLAUDE_RE = /\bclaude\b/;

/** First whitespace-delimited token of an argv string (the executable). */
function argv0(argv: string): string {
  return argv.trim().split(/\s+/, 1)[0] ?? "";
}

/** POSIX basename of a path-or-bare token (handles `/` separators). */
function basename(token: string): string {
  const slash = token.lastIndexOf("/");
  return slash >= 0 ? token.slice(slash + 1) : token;
}

/**
 * pi-SPECIFIC root check. True iff the pane ROOT argv is a pi process:
 * the trimmed argv equals `pi`, or the basename of argv[0] is `pi`.
 *
 * This is the decisive rule that excludes a normal pi session (which the
 * dashboard already shows) — including a pi agent that spawned a *headless*
 * `claude --output-format stream-json` child: her pane root is `pi`, so the
 * whole session is skipped regardless of its children.
 */
export function isPiRootArgv(argv: string): boolean {
  const trimmed = argv.trim();
  if (trimmed === "pi") return true;
  return basename(argv0(trimmed)) === "pi";
}

/**
 * Classify a set of candidate argv strings (a pane root's argv PLUS its
 * immediate children) into an external runtime. Codex is checked before
 * Claude Code because a Codex child argv contains `node` and could otherwise
 * be ambiguous; codex is the stronger signal. Returns null when nothing
 * matches (not an external agent session → skip).
 */
export function classifyRuntime(argvCandidates: readonly string[]): ExternalRuntime | null {
  if (argvCandidates.some((a) => CODEX_RE.test(a))) return "codex";
  if (argvCandidates.some((a) => CLAUDE_RE.test(a))) return "claude-code";
  return null;
}

/**
 * Pure liveness sub-predicate: does `argv` still look like the claimed
 * `runtime`? Used by the liveness model to reject a runtime pid whose process
 * has been replaced by a bare reused shell (pid recycled). codex→`\bcodex\b`,
 * claude-code→`\bclaude\b`.
 */
export function runtimeArgvMatches(runtime: ExternalRuntime, argv: string): boolean {
  return runtime === "codex" ? CODEX_RE.test(argv) : CLAUDE_RE.test(argv);
}

/**
 * Convenience combinator applying the full decision to a pane: pi-root wins
 * (skip), else classify over root + children. Pure; the scanner and the
 * "pi wins" test both use it.
 */
export function classifySession(input: {
  rootArgv: string;
  childArgvs: readonly string[];
}): ExternalRuntime | null {
  if (isPiRootArgv(input.rootArgv)) return null;
  return classifyRuntime([input.rootArgv, ...input.childArgvs]);
}
