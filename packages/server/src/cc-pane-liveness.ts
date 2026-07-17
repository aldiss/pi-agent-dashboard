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
  return probeClaudePanesUncached().panes;
}

/**
 * Tri-state CC-pane probe (build-2 fix-cycle FATAL 1). Distinguishes a
 * SUCCESSFUL-EMPTY probe (`{ panes: [], ok: true }` — tmux answered, no claude
 * panes → a CC session with no pane is PROVEN dead) from a FAILED probe
 * (`{ panes: [], ok: false }` — tmux missing / no server / non-zero exit /
 * timeout → liveness UNKNOWN, must not be treated as proof of death).
 *
 * The legacy {@link listClaudePanesUncached} collapsed both to `[]`, so a
 * transient tmux failure looked identical to "no live panes" and let
 * `verifySessionLive` return a false `dead` verdict that `evaluateRetire`
 * honoured (removing a genuinely-unverified session). Callers that need the
 * distinction use THIS; the old signature stays for the pane list itself.
 */
export function probeClaudePanesUncached(): { panes: ClaudePane[]; ok: boolean } {
  try {
    const out = execFileSync("tmux", ["list-panes", "-a", "-F", TMUX_FORMAT], {
      encoding: "utf8",
      timeout: 1000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { panes: parseClaudePanes(out), ok: true };
  } catch {
    // no tmux server / not installed / timeout / non-zero exit → UNKNOWN, not
    // proven-empty. ok:false so the liveness predicate returns `cc-unknown`.
    return { panes: [], ok: false };
  }
}

/**
 * Probe tmux for all live SESSION NAMES (not panes). A pi-driver spawned via
 * spawn-driver runs in a tmux session named after its mesh name, so a live
 * session named `<Driver>` proves that driver alive — INDEPENDENT of the
 * messenger registry AND the session row's pid. This is the pi-driver analogue
 * of {@link listClaudePanesUncached}, but keyed by session-NAME, not cwd:
 * pi-drivers frequently share a cwd (orchestration-state, worktrees), so a
 * cwd-match would false-KEEP a dead ghost sharing a live driver's cwd; the
 * session-name binds to the specific driver. It closes the null-row-pid +
 * REG-absent liveness gap (a live-but-unregistered tmux pi-driver whose row
 * carries no pid). Fail-safe: `[]` on ANY tmux error, so a probe miss never
 * resurrects — it only ever KEEPS a row that has a matching live session.
 */
export function listDriverTmuxSessionsUncached(): string[] {
  // Union the DEFAULT socket AND the `-L pi` socket: spawn-driver creates pi-
  // driver sessions on `tmux -L pi` (dl-3452), while CC / ad-hoc sessions may sit
  // on the default socket. Querying BOTH (and unioning) means the probe sees a
  // live driver regardless of which socket holds it — critical because the prod
  // server runs under launchd (NOT inside a driver's tmux), so its default
  // socket differs from an interactive shell's. Fail-safe direction (a seen live
  // session → KEEP); each socket's error is swallowed independently.
  const names = new Set<string>();
  for (const socketArgs of [[] as string[], ["-L", "pi"]]) {
    try {
      const out = execFileSync("tmux", [...socketArgs, "list-sessions", "-F", "#{session_name}"], {
        encoding: "utf8",
        timeout: 1000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      for (const line of out.split("\n")) {
        const s = line.trim();
        if (s) names.add(s);
      }
    } catch {
      // socket absent / tmux missing / timeout → skip this socket (fail-safe)
    }
  }
  return [...names];
}

/**
 * TTL-cached wrapper over {@link listClaudePanesUncached}. The `/api/sessions`
 * read-path can fire several times in quick succession (multi-tab, reconnect
 * storms); a short cache collapses the burst into one `tmux` spawn. `nowMs` is
 * injectable for deterministic tests.
 *
 * Also exposes `claudePanesOk()` — the tri-state probe outcome of the SAME
 * cached snapshot (build-2 fix-cycle FATAL 1). `true` when the last probe
 * answered (even success-empty); `false` when it FAILED (tmux missing / non-zero
 * exit / timeout) → liveness UNKNOWN. Both read the one cached probe so the
 * pane list and its ok-ness never disagree.
 */export function createClaudePaneProbe(opts?: {
  ttlMs?: number;
  list?: () => ClaudePane[];
  probe?: () => { panes: ClaudePane[]; ok: boolean };
  now?: () => number;
}): { listClaudePanes: () => ClaudePane[]; claudePanesOk: () => boolean } {
  const ttlMs = opts?.ttlMs ?? 2000;
  // Prefer a tri-state `probe`; else adapt a legacy `list` (always ok:true);
  // else the real tri-state probe.
  const probe = opts?.probe
    ?? (opts?.list ? () => ({ panes: opts.list!(), ok: true }) : probeClaudePanesUncached);
  const now = opts?.now ?? Date.now;
  let cache: { panes: ClaudePane[]; ok: boolean } | null = null;
  let cachedAt = 0;
  function snapshot(): { panes: ClaudePane[]; ok: boolean } {
    const t = now();
    if (cache && t - cachedAt < ttlMs) return cache;
    cache = probe();
    cachedAt = t;
    return cache;
  }
  return {
    listClaudePanes: () => snapshot().panes,
    claudePanesOk: () => snapshot().ok,
  };
}
