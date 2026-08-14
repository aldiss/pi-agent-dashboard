/**
 * Read-only tmux wrappers for the external-session viewer.
 *
 * THE ONE HARD BOUNDARY: these wrappers are the ONLY tmux entry point for the
 * external-session surface, and every call funnels through `runTmux`, which
 * refuses any subcommand not on `ALLOWED_SUBCOMMANDS`. The allowed set is
 * exactly the non-destructive reads:
 *
 *   list-sessions, list-panes, has-session, display-message, capture-pane
 *
 * A disallowed subcommand (send-keys, resize-*, kill-*, select-*, set-option,
 * respawn-*, swap-*, …) THROWS before spawning — it never executes. Reading a
 * pane must not steal focus, resize it, interrupt it, or alter the session:
 * an ultra Codex run interrupted mid-flight loses 20–40 minutes of work.
 *
 * Exit-code discipline: every call is `spawnSync(argv)` (no shell), and callers
 * read `result.status` directly. A non-zero status from has-session/capture-pane
 * is itself the signal the pane is gone — it is surfaced, never swallowed.
 */
import {
  spawnSync as nodeSpawnSync,
  type SpawnSyncReturns,
} from "@blackbelt-technology/pi-dashboard-shared/platform/exec.js";

/** Injectable spawnSync shape (subset we depend on). */
export type SpawnSyncFn = (
  cmd: string,
  args: readonly string[],
  opts: { encoding: "utf8"; timeout?: number },
) => SpawnSyncReturns<string>;

/** tmux socket every external session lives on. */
export const TMUX_SOCKET = "pi";

/** Non-destructive read subcommands — the complete allowlist. */
export const ALLOWED_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "list-sessions",
  "list-panes",
  "has-session",
  "display-message",
  "capture-pane",
]);

const DEFAULT_TIMEOUT_MS = 2000;

/** Thrown when a caller attempts a tmux subcommand outside the read allowlist. */
export class DisallowedTmuxSubcommandError extends Error {
  constructor(public readonly subcommand: string) {
    super(
      `Refusing tmux subcommand "${subcommand}": external-session reads are ` +
        `restricted to [${[...ALLOWED_SUBCOMMANDS].join(", ")}]. Mutating/` +
        `focus-stealing subcommands are forbidden.`,
    );
    this.name = "DisallowedTmuxSubcommandError";
  }
}

export interface TmuxReadResult {
  /** Exit status; null when the process was killed/failed to spawn. */
  status: number | null;
  /** stdout (empty string on failure). */
  stdout: string;
}

/**
 * The single guarded tmux entry point. Prepends `-L pi`, validates the
 * subcommand against the allowlist (throws if disallowed), and returns typed
 * `{ status, stdout }`. Never throws on tmux failure — only on a disallowed
 * subcommand (a programming error).
 */
export function runTmux(
  subcommand: string,
  args: readonly string[],
  spawnSync: SpawnSyncFn = nodeSpawnSync as unknown as SpawnSyncFn,
): TmuxReadResult {
  if (!ALLOWED_SUBCOMMANDS.has(subcommand)) {
    throw new DisallowedTmuxSubcommandError(subcommand);
  }
  const argv = ["-L", TMUX_SOCKET, subcommand, ...args];
  try {
    const r = spawnSync("tmux", argv, { encoding: "utf8", timeout: DEFAULT_TIMEOUT_MS });
    return { status: r.status, stdout: typeof r.stdout === "string" ? r.stdout : "" };
  } catch {
    // spawn itself failed (tmux missing) — treat as a non-zero read.
    return { status: null, stdout: "" };
  }
}

/** One tmux session with its pane's root pid. */
export interface TmuxSessionPane {
  sessionName: string;
  panePid: number | null;
}

/**
 * `list-panes -a` across all sessions on socket pi, one entry per session's
 * first pane: `pane_pid session_name`. Returns `[]` on any tmux failure.
 *
 * The delimiter is a SPACE with pane_pid FIRST, deliberately NOT a tab: when
 * tmux renders `-F` output under a stripped server env (no locale / no TTY, as
 * the production dashboard is launched), it sanitizes control characters like
 * TAB to `_`. A tab delimiter therefore silently collapsed every row into one
 * unparseable field in production (all pane_pids null → every session skipped
 * → empty panel), even though it worked from an interactive shell. pane_pid is
 * always leading digits and a space is printable (never sanitized); the session
 * name is the remainder (and may itself contain spaces), so parse from the left.
 */
export function listSessions(spawnSync?: SpawnSyncFn): TmuxSessionPane[] {
  const r = runTmux("list-panes", ["-a", "-F", "#{pane_pid} #{session_name}"], spawnSync);
  if (r.status !== 0 || !r.stdout) return [];
  const seen = new Set<string>();
  const out: TmuxSessionPane[] = [];
  for (const line of r.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^(\d+)\s+(.+)$/);
    if (!m) continue;
    const name = m[2]!;
    if (seen.has(name)) continue; // first pane per session only
    seen.add(name);
    const pid = Number.parseInt(m[1]!, 10);
    out.push({ sessionName: name, panePid: Number.isInteger(pid) && pid > 0 ? pid : null });
  }
  return out;
}

/** pane_pid of a named session's active pane, or null if unresolved/gone. */
export function paneRootPid(sess: string, spawnSync?: SpawnSyncFn): number | null {
  const r = runTmux("list-panes", ["-t", sess, "-F", "#{pane_pid}"], spawnSync);
  if (r.status !== 0 || !r.stdout) return null;
  const first = r.stdout.split("\n").map((l) => l.trim()).find(Boolean);
  const pid = Number.parseInt(first ?? "", 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** `has-session -t <sess>` — true iff exit status is 0. */
export function hasSession(sess: string, spawnSync?: SpawnSyncFn): boolean {
  return runTmux("has-session", ["-t", sess], spawnSync).status === 0;
}

/**
 * `capture-pane -p -t <sess>` (optionally `-S -<lines>` scrollback). Returns
 * `{ status, output, lineCount }`. A non-zero status means the pane is gone —
 * surfaced so the caller can treat it as a liveness signal.
 */
export function capture(
  sess: string,
  lines?: number,
  spawnSync?: SpawnSyncFn,
): { status: number | null; output: string; lineCount: number } {
  const args = ["-p", "-t", sess];
  if (typeof lines === "number" && lines > 0) {
    args.push("-S", `-${Math.floor(lines)}`);
  }
  const r = runTmux("capture-pane", args, spawnSync);
  const output = r.status === 0 ? r.stdout.replace(/\s+$/, "") : "";
  const lineCount = output ? output.split("\n").length : 0;
  return { status: r.status, output, lineCount };
}

/** Best-effort `pane_current_path` for a session; null if unavailable. */
export function paneCurrentPath(sess: string, spawnSync?: SpawnSyncFn): string | null {
  const r = runTmux("display-message", ["-p", "-t", sess, "#{pane_current_path}"], spawnSync);
  if (r.status !== 0) return null;
  const path = r.stdout.trim();
  return path.length > 0 ? path : null;
}
