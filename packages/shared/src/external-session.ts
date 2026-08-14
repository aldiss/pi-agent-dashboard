/**
 * External-session types — read-only view of Codex / Claude Code sessions that
 * run in tmux panes on socket `pi`, invisible to the pi-session pipeline.
 *
 * These sessions are NOT pi sessions and NOT bridged. The dashboard reads them
 * non-destructively (tmux capture-pane) and surfaces them read-only. There is
 * no input path from the dashboard to a pane — viewing only.
 *
 * `state` is a two-value honesty predicate: a pane that has died must look
 * dead ("ended"), never stale-live. See scanner.ts for the transition
 * semantics + retention.
 */

/** Runtime kind of an external agent session. Never lumped as "other". */
export type ExternalRuntime = "codex" | "claude-code";

/** Discrete liveness state. `ended` output is frozen at the last capture. */
export type ExternalSessionState = "live" | "ended";

export interface ExternalSession {
  /** Stable id = `${runtime}:${tmuxSession}`. */
  id: string;
  runtime: ExternalRuntime;
  /** tmux session name (e.g. "cx-gap2"). */
  tmuxSession: string;
  /** tmux socket the session lives on (always "pi" today). */
  tmuxSocket: string;
  /** Human title — the tmux session name today. */
  title: string;
  /** Best-effort cwd (pane_current_path); null when unavailable. */
  cwd: string | null;
  /**
   * Pid of the matched codex/claude process (a child of the shell pane), NOT
   * the pane pid. This is the pid tracked for liveness. Null if unresolved.
   */
  runtimePid: number | null;
  state: ExternalSessionState;
  /** Best-effort model string parsed from the capture (e.g. "gpt-5.6-sol"). */
  model: string | null;
  /** Best-effort effort/mode parsed from the capture (e.g. "ultra"). */
  effort: string | null;
  /** ms epoch of first observation. */
  firstSeenAt: number;
  /** ms epoch of the last time the liveness predicate held. */
  lastLiveAt: number;
  /** ms epoch of the transition to "ended"; null while live. */
  endedAt: number | null;
  /** Last captured pane text (frozen when ended). */
  output: string;
  /** ms epoch the `output` field was last refreshed. */
  outputAt: number;
  /** Line count of `output`. */
  lineCount: number;
}
