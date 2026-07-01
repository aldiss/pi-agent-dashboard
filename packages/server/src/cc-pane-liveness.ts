/**
 * CC-pane liveness probe (F4 — dl-2732, dashboard-session-row-hygiene).
 *
 * CC sessions spawned via `cc-launch` are tmux panes running `claude` (not
 * `pi`), so they have NO pi-bridge to hold them active and NO messenger-registry
 * entry. They therefore (a) register under PROMPT-TEXT as their name and (b)
 * drop to `status:"ended"` while the tmux pane is still alive+working. The
 * driver-liveness.ts registry+kill-0 discriminator can't see them (no registry
 * bind). This module is the sister discriminator: liveness via the tmux PANE.
 *
 * Ground-truth: a live `claude` tmux pane whose `pane_current_path` matches a
 * CC session's `cwd` proves that CC session (the newest in that cwd) is LIVE.
 * The pane's `session_name` (e.g. `cc-row-hygiene-build`) is the clean name —
 * NEVER the prompt-text. This is the exact analogue of F1's registry kill-0:
 * pane-alive = live, pane-gone = dead.
 *
 * Read-only + fail-safe: any tmux error (no server, not installed) yields an
 * EMPTY pane list, so CC sessions keep their existing ended+hidden default —
 * never resurrected on a probe failure (mirrors driver-liveness fail-safe).
 */
import { execFileSync } from "node:child_process";

/** One live tmux pane running a `claude` command. */
export interface ClaudePane {
  /** tmux session-name — the clean name (e.g. "cc-row-hygiene-build"). */
  sessionName: string;
  /** `pane_current_path` — the cwd join key against a CC session's `cwd`. */
  cwd: string;
  /** `pane_pid` — the live pid (for the retire-endpoint verify-dead predicate). */
  pid: number;
}

/**
 * Parse `tmux list-panes` output (one pane per line, tab-separated
 * `session_name \t pane_current_command \t pane_current_path \t pane_pid`)
 * into the subset of panes whose command is a `claude` process.
 *
 * Pure + exported for tests. The command match is a case-insensitive
 * `claude` substring so it tolerates `claude`, `claude.exe`, and any
 * wrapper that keeps `claude` in the resolved command name.
 */
export function parseClaudePanes(raw: string): ClaudePane[] {
  const panes: ClaudePane[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const [sessionName, command, cwd, pidStr] = line.split("\t");
    if (!sessionName || !command || !cwd) continue;
    if (!command.toLowerCase().includes("claude")) continue;
    const pid = Number.parseInt(pidStr ?? "", 10);
    panes.push({
      sessionName,
      cwd,
      pid: Number.isInteger(pid) && pid > 0 ? pid : 0,
    });
  }
  return panes;
}

const TMUX_FORMAT = "#{session_name}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_pid}";

/**
 * Probe tmux for all live `claude` panes. Returns `[]` on ANY failure
 * (tmux missing, no server running, non-zero exit) — fail-safe so a probe
 * miss NEVER resurrects a CC session. 1s timeout caps read-path latency.
 */
export function listClaudePanesUncached(): ClaudePane[] {
  try {
    const out = execFileSync("tmux", ["list-panes", "-a", "-F", TMUX_FORMAT], {
      encoding: "utf8",
      timeout: 1000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parseClaudePanes(out);
  } catch {
    return []; // no tmux server / not installed / timeout → no live CC panes
  }
}

/**
 * TTL-cached wrapper over {@link listClaudePanesUncached}. The `/api/sessions`
 * read-path can fire several times in quick succession (multi-tab, reconnect
 * storms); a short cache collapses the burst into one `tmux` spawn. `nowMs` is
 * injectable for deterministic tests.
 */
export function createClaudePaneProbe(opts?: {
  ttlMs?: number;
  list?: () => ClaudePane[];
  now?: () => number;
}): { listClaudePanes: () => ClaudePane[] } {
  const ttlMs = opts?.ttlMs ?? 2000;
  const list = opts?.list ?? listClaudePanesUncached;
  const now = opts?.now ?? Date.now;
  let cache: ClaudePane[] | null = null;
  let cachedAt = 0;
  return {
    listClaudePanes(): ClaudePane[] {
      const t = now();
      if (cache && t - cachedAt < ttlMs) return cache;
      cache = list();
      cachedAt = t;
      return cache;
    },
  };
}
