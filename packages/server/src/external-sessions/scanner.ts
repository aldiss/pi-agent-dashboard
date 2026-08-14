/**
 * External-session scanner + registry.
 *
 * `scanExternalSessions` = pure-ish discovery: enumerate tmux sessions on
 * socket pi, read each pane's root argv (+ immediate children), classify into
 * codex / claude-code (pi roots skipped), and non-destructively capture the
 * current output. Returns the current live snapshot.
 *
 * `createExternalSessionRegistry` = the stateful layer. `refresh()` folds a
 * fresh scan into a persistent store and applies the honesty transitions:
 *   - new session            → add as state:"live"
 *   - present & live          → update output/lastLiveAt/outputAt; stamp outputChangedAt on change
 *   - was live, now not live   → state:"ended", set endedAt, FREEZE output, KEEP it
 *   - ended past retention     → prune unless capture polling keeps its view lease active
 *
 * Liveness is a single discrete predicate `isExternalSessionLive` (exported and
 * exposed on the registry). Break it and a dead pane wrongly looks live — that
 * is the must-not-lie guard the supervisor deliberately breaks then restores.
 *
 * All external commands run via injected `spawnSync` (argv form, no shell) and
 * read `.status` directly. `now()` and `procAlive(pid)` are injected too, so
 * tests drive transitions deterministically.
 */
import { spawnSync as nodeSpawnSync } from "@blackbelt-technology/pi-dashboard-shared/platform/exec.js";
import { isProcessAlive } from "@blackbelt-technology/pi-dashboard-shared/platform/process.js";
import type {
  ExternalRuntime,
  ExternalSession,
} from "@blackbelt-technology/pi-dashboard-shared/external-session.js";
import {
  capture as tmuxCapture,
  hasSession as tmuxHasSession,
  listSessions as tmuxListSessions,
  paneCurrentPath as tmuxPaneCurrentPath,
  type SpawnSyncFn,
} from "./tmux-read.js";
import { classifySession, isPiRootArgv, runtimeArgvMatches } from "./classify.js";

export const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_VIEW_GRACE_MS = 30 * 1000;
const LIST_CAPTURE_LINES = 200; // scrollback for the list snapshot
const DRILL_CAPTURE_LINES = 1000; // larger scrollback for the drill-in

/** One observation of a currently-present external session (discovery output). */
export interface ExternalSessionObservation {
  runtime: ExternalRuntime;
  tmuxSession: string;
  runtimePid: number | null;
  cwd: string | null;
  model: string | null;
  effort: string | null;
  output: string;
  lineCount: number;
}

/** Read a pid's root argv via `ps -o command=`. Empty string on failure. */
function makeProcArgv(spawnSync: SpawnSyncFn): (pid: number) => string {
  return (pid: number): string => {
    try {
      const r = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
      return r.status === 0 && typeof r.stdout === "string" ? r.stdout.trim() : "";
    } catch {
      return "";
    }
  };
}

/** Immediate child pids of `pid` via `pgrep -P`. Empty array on failure. */
function makeChildPids(spawnSync: SpawnSyncFn): (pid: number) => number[] {
  return (pid: number): number[] => {
    try {
      const r = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" });
      if (r.status !== 0 || typeof r.stdout !== "string") return [];
      return r.stdout
        .split("\n")
        .map((s) => Number.parseInt(s.trim(), 10))
        .filter((n) => Number.isInteger(n) && n > 0);
    } catch {
      return [];
    }
  };
}

/**
 * Best-effort model/effort parse from the capture text. Never throws; returns
 * nulls when nothing matches. Tuned to the real banners:
 *   Codex:  `gpt-5.6-sol ultra · /path · Branch`  → model="gpt-5.6-sol", effort="ultra"
 *   Claude: `Opus 4 (1M context) · API Usage`      → model="Opus 4 (1M context)", effort=null
 */
export function parseModelEffort(
  runtime: ExternalRuntime,
  text: string,
): { model: string | null; effort: string | null } {
  if (runtime === "codex") {
    // Segment before the first ` · `, expecting `<model> <effort>`.
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*([A-Za-z][\w.\-]*)\s+([A-Za-z][\w.\-]*)\s+·/);
      if (m && /[\d.-]/.test(m[1]!)) {
        return { model: m[1]!, effort: m[2]! };
      }
    }
    return { model: null, effort: null };
  }
  // claude-code: capture the `Opus|Sonnet|Haiku …` model line up to a ` · ` or EOL.
  const m = text.match(/\b(Opus|Sonnet|Haiku)\b[^\n·]*/i);
  if (m) {
    return { model: m[0].trim(), effort: null };
  }
  return { model: null, effort: null };
}

export interface ScanDeps {
  spawnSync?: SpawnSyncFn;
  procArgv?: (pid: number) => string;
  childPids?: (pid: number) => number[];
  captureLines?: number;
}

/**
 * Discover the currently-present external sessions on socket pi. Skips pi
 * roots entirely (pi wins). Returns one observation per codex/claude session
 * with its current (non-destructively captured) output.
 */
export function scanExternalSessions(deps: ScanDeps = {}): ExternalSessionObservation[] {
  const spawnSync = deps.spawnSync ?? (nodeSpawnSync as unknown as SpawnSyncFn);
  const procArgv = deps.procArgv ?? makeProcArgv(spawnSync);
  const childPids = deps.childPids ?? makeChildPids(spawnSync);
  const captureLines = deps.captureLines ?? LIST_CAPTURE_LINES;

  const observations: ExternalSessionObservation[] = [];
  for (const { sessionName, panePid } of tmuxListSessions(spawnSync)) {
    if (panePid == null) continue;
    const rootArgv = procArgv(panePid);
    // pi wins — skip before touching children (decisive exclusion rule).
    if (isPiRootArgv(rootArgv)) continue;

    const children = childPids(panePid).map((pid) => ({ pid, argv: procArgv(pid) }));
    const candidates = [{ pid: panePid, argv: rootArgv }, ...children];
    const runtime = classifySession({ rootArgv, childArgvs: children.map((c) => c.argv) });
    if (!runtime) continue;

    // Runtime pid = the pid of the candidate whose argv matched the runtime
    // (a child pid for the shell→codex/claude case), NOT the shell pane pid.
    const matched = candidates.find((c) => runtimeArgvMatches(runtime, c.argv));
    const runtimePid = matched?.pid ?? null;

    const cap = tmuxCapture(sessionName, captureLines, spawnSync);
    const { model, effort } = parseModelEffort(runtime, cap.output);
    observations.push({
      runtime,
      tmuxSession: sessionName,
      runtimePid,
      cwd: tmuxPaneCurrentPath(sessionName, spawnSync),
      model,
      effort,
      output: cap.output,
      lineCount: cap.lineCount,
    });
  }
  return observations;
}

/** Dependency bundle for the liveness predicate. */
export interface LivenessDeps {
  hasSession: (sess: string) => boolean;
  procAlive: (pid: number) => boolean;
  procArgv: (pid: number) => string;
}

/**
 * THE liveness predicate — a dead pane must look dead. All three must hold:
 *   1. tmux has-session succeeds (pane/session still exists)
 *   2. the tracked runtime pid is still alive
 *   3. that pid's argv still matches its runtime (not a bare reused shell)
 */
export function isExternalSessionLive(session: ExternalSession, deps: LivenessDeps): boolean {
  if (!deps.hasSession(session.tmuxSession)) return false;
  if (session.runtimePid == null || !deps.procAlive(session.runtimePid)) return false;
  return runtimeArgvMatches(session.runtime, deps.procArgv(session.runtimePid));
}

export interface ExternalSessionRegistryDeps {
  spawnSync?: SpawnSyncFn;
  now?: () => number;
  procAlive?: (pid: number) => boolean;
  procArgv?: (pid: number) => string;
  childPids?: (pid: number) => number[];
  hasSession?: (sess: string) => boolean;
  /** Discovery override (defaults to the real tmux scan). */
  scan?: () => ExternalSessionObservation[];
  /** Liveness override (defaults to `isExternalSessionLive`). Break to test the guard. */
  isLive?: (session: ExternalSession) => boolean;
  /** Fresh larger-scrollback read for a live drill-in (defaults to tmux capture). */
  captureLive?: (sess: string) => { status: number | null; output: string; lineCount: number };
  retentionMs?: number;
  /** Capture polling renews this lease; ended sessions under lease are not pruned. */
  viewGraceMs?: number;
}

export interface ExternalSessionRegistry {
  refresh(): void;
  list(): ExternalSession[];
  isExternalSessionLive(session: ExternalSession): boolean;
  captureOne(
    id: string,
  ): { id: string; output: string; lineCount: number; state: ExternalSession["state"]; capturedAt: number } | null;
}

/**
 * Create the stateful external-session registry. Production callers pass only
 * `{ spawnSync, now, procAlive }` (or nothing → all real defaults); tests
 * override `scan`/`isLive`/`now` to drive transitions deterministically.
 */
export function createExternalSessionRegistry(
  deps: ExternalSessionRegistryDeps = {},
): ExternalSessionRegistry {
  const spawnSync = deps.spawnSync ?? (nodeSpawnSync as unknown as SpawnSyncFn);
  const now = deps.now ?? Date.now;
  const procAlive = deps.procAlive ?? ((pid: number) => isProcessAlive(pid));
  const procArgv = deps.procArgv ?? makeProcArgv(spawnSync);
  const childPids = deps.childPids ?? makeChildPids(spawnSync);
  const hasSession = deps.hasSession ?? ((sess: string) => tmuxHasSession(sess, spawnSync));
  const scan =
    deps.scan ?? (() => scanExternalSessions({ spawnSync, procArgv, childPids }));
  const isLive =
    deps.isLive ??
    ((session: ExternalSession) => isExternalSessionLive(session, { hasSession, procAlive, procArgv }));
  const captureLive =
    deps.captureLive ?? ((sess: string) => tmuxCapture(sess, DRILL_CAPTURE_LINES, spawnSync));
  const retentionMs = deps.retentionMs ?? DEFAULT_RETENTION_MS;
  const viewGraceMs = deps.viewGraceMs ?? DEFAULT_VIEW_GRACE_MS;

  const store = new Map<string, ExternalSession>();
  const viewedUntil = new Map<string, number>();
  const drillCaptures = new Map<string, { output: string; lineCount: number; capturedAt: number }>();

  function idOf(runtime: ExternalRuntime, tmuxSession: string): string {
    return `${runtime}:${tmuxSession}`;
  }

  function refresh(): void {
    const t = now();
    const observed = scan();
    const observedIds = new Set<string>();

    for (const obs of observed) {
      const id = idOf(obs.runtime, obs.tmuxSession);
      observedIds.add(id);
      const existing = store.get(id);
      if (!existing) {
        drillCaptures.delete(id);
        store.set(id, {
          id,
          runtime: obs.runtime,
          tmuxSession: obs.tmuxSession,
          tmuxSocket: "pi",
          title: obs.tmuxSession,
          cwd: obs.cwd,
          runtimePid: obs.runtimePid,
          state: "live",
          model: obs.model,
          effort: obs.effort,
          firstSeenAt: t,
          lastLiveAt: t,
          endedAt: null,
          output: obs.output,
          outputAt: t,
          outputChangedAt: null,
          lineCount: obs.lineCount,
        });
      } else {
        // Present & observed → live. Revive if it had been marked ended and
        // the same id reappeared (operator relaunched in the same tmux session).
        if (existing.state === "ended") drillCaptures.delete(id);
        const outputChanged = existing.output !== obs.output;
        existing.state = "live";
        existing.endedAt = null;
        existing.output = obs.output;
        existing.outputAt = t;
        if (outputChanged) existing.outputChangedAt = t;
        existing.lineCount = obs.lineCount;
        existing.lastLiveAt = t;
        if (obs.cwd != null) existing.cwd = obs.cwd;
        if (obs.runtimePid != null) existing.runtimePid = obs.runtimePid;
        if (obs.model != null) existing.model = obs.model;
        if (obs.effort != null) existing.effort = obs.effort;
      }
    }

    // Stored but not observed this scan → the liveness predicate is the authority.
    for (const [id, s] of store) {
      if (observedIds.has(id)) continue;
      if (s.state === "ended") {
        const viewLeaseActive = t < (viewedUntil.get(id) ?? 0);
        if (s.endedAt != null && t - s.endedAt >= retentionMs && !viewLeaseActive) {
          store.delete(id);
          viewedUntil.delete(id);
          drillCaptures.delete(id);
        }
        continue;
      }
      if (isLive(s)) {
        s.lastLiveAt = t; // still live (belt & suspenders); keep prior frozen-free output
      } else {
        s.state = "ended";
        s.endedAt = t;
        // FREEZE: leave s.output / s.lineCount at their last live values.
      }
    }
  }

  function list(): ExternalSession[] {
    return [...store.values()].sort((a, b) => {
      if (a.state !== b.state) return a.state === "live" ? -1 : 1;
      return b.lastLiveAt - a.lastLiveAt;
    });
  }

  function captureOne(id: string) {
    const s = store.get(id);
    if (!s) return null;
    const t = now();
    viewedUntil.set(id, t + viewGraceMs);
    if (s.state === "ended") {
      // Frozen output — never re-read a dead pane.
      const drill = drillCaptures.get(id);
      return {
        id,
        output: drill?.output ?? s.output,
        lineCount: drill?.lineCount ?? s.lineCount,
        state: s.state,
        capturedAt: drill?.capturedAt ?? s.outputAt,
      };
    }
    const cap = captureLive(s.tmuxSession);
    if (cap.status === 0) {
      // Detail reads 1000 lines while refresh samples 200. Keep them separate:
      // comparing/replacing across capture depths would fabricate activity on
      // every detail poll and the following list refresh.
      drillCaptures.set(id, { output: cap.output, lineCount: cap.lineCount, capturedAt: t });
      return { id, output: cap.output, lineCount: cap.lineCount, state: s.state, capturedAt: t };
    }
    // Read failed — fall back to the last known output without lying about state.
    const drill = drillCaptures.get(id);
    return {
      id,
      output: drill?.output ?? s.output,
      lineCount: drill?.lineCount ?? s.lineCount,
      state: s.state,
      capturedAt: drill?.capturedAt ?? s.outputAt,
    };
  }

  return {
    refresh,
    list,
    isExternalSessionLive: isLive,
    captureOne,
  };
}
