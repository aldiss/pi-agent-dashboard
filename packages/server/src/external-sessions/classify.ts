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
/** Interpreters whose first non-flag argument is the actual program. */
const INTERPRETERS = new Set(["node", "nodejs"]);

/** POSIX basename of a path-or-bare token (handles `/` separators). */
function basename(token: string): string {
  const slash = token.lastIndexOf("/");
  return slash >= 0 ? token.slice(slash + 1) : token;
}

/**
 * The tokens that identify which program an argv is running: the executable,
 * plus the script when the executable is an interpreter. Arguments after the
 * program are deliberately excluded, so a flag such as `--model claude-opus-5`
 * or `--model gpt-5.3-codex` can never decide a session's identity.
 */
function programTokens(argv: string): string[] {
  const tokens = argv.trim().split(/\s+/);
  const exe = tokens[0] ?? "";
  if (!INTERPRETERS.has(basename(exe))) return [exe];
  const script = tokens.slice(1).find((token) => !token.startsWith("-"));
  return script === undefined ? [exe] : [exe, script];
}

/**
 * pi-SPECIFIC root check. True iff the pane ROOT argv is a pi process: the
 * trimmed argv equals `pi`, the basename of argv[0] is `pi`, or a node process
 * is running pi — its npm bin (basename `pi`) or the guarded `pi-releases`
 * launcher. A node-led argv running anything else (e.g. codex) is not pi.
 *
 * This is the decisive rule that excludes a normal pi session (which the
 * dashboard already shows) — including a pi agent that spawned a *headless*
 * `claude --output-format stream-json` child: her pane root is pi, so the
 * whole session is skipped regardless of its children.
 */
export function isPiRootArgv(argv: string): boolean {
  const trimmed = argv.trim();
  if (trimmed === "pi") return true;
  const [exe, script] = programTokens(trimmed);
  if (basename(exe) === "pi") return true;
  return script !== undefined && (basename(script) === "pi" || script.includes("/pi-releases/"));
}

/**
 * Classify a set of candidate argv strings (a pane root's argv PLUS its
 * immediate children) into an external runtime, by the program each one runs.
 * Codex is checked before Claude Code because codex is the stronger signal.
 * Returns null when nothing matches (not an external agent session → skip).
 */
export function classifyRuntime(argvCandidates: readonly string[]): ExternalRuntime | null {
  const programs = argvCandidates.flatMap(programTokens);
  if (programs.some((program) => CODEX_RE.test(program))) return "codex";
  if (programs.some((program) => CLAUDE_RE.test(program))) return "claude-code";
  return null;
}

/**
 * Pure liveness sub-predicate: does `argv` still run the claimed `runtime`?
 * Used by the liveness model to reject a runtime pid whose process has been
 * replaced by a bare reused shell (pid recycled). Checks the program only,
 * never its arguments: codex→`\bcodex\b`, claude-code→`\bclaude\b`.
 */
export function runtimeArgvMatches(runtime: ExternalRuntime, argv: string): boolean {
  const pattern = runtime === "codex" ? CODEX_RE : CLAUDE_RE;
  return programTokens(argv).some((program) => pattern.test(program));
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
