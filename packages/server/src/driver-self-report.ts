/**
 * Driver self-report ingest (dl-2620) — progress-% + next-engagement-effort.
 *
 * The operator wants two MORE per-driver indicators in the session-list, shown
 * ALONGSIDE the existing context-% so he can triage async-mode drivers at a
 * glance: (1) progress-% — how much of the dispatched work is done; (2) next-
 * engagement-effort — how much operator effort the NEXT step needs. A driver
 * self-reports both via the `driver-report` CLI, which writes an atomic sidecar
 * at `~/.pi/orchestration-state/driver-state/<name>.json` (keyed by mesh themed-
 * name == $PI_AGENT_NAME). This module is the dashboard READ side.
 *
 * Binding: the sidecar is keyed by the SAME clean themed-name that
 * `driver-liveness.ts` already resolves for a live session (registry
 * sessionId-join → name). The sidecar also carries `session_id` (best-effort,
 * from the registry at write time); when present and it does NOT match the live
 * session's id, the sidecar is a STALE prior-tenure report and is ignored
 * (Pattern-87 antibody at the data layer).
 *
 * Lifecycle: SERVER-polled (the sidecar is a file the CLI writes; there is no
 * bridge push). The poller mutates `sessionManager` + broadcasts on change, so
 * both freshly-connecting browsers (manager state) and live browsers (broadcast)
 * stay current. progress/nextEngagement are deliberately NOT in the .meta.json
 * persistence allowlist — they are re-derived from the sidecar each tick
 * (sister to `lastActivityAt`), never stale-persisted.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  DashboardSession,
  DriverProgress,
  DriverNextEngagement,
  EngagementEffort,
} from "@blackbelt-technology/pi-dashboard-shared/types.js";

export interface DriverSelfReport {
  progress?: DriverProgress;
  nextEngagement?: DriverNextEngagement;
}

const EFFORTS: readonly EngagementEffort[] = [
  "autonomous",
  "one-action",
  "short",
  "back-and-forth",
];
const NAME_RE = /^[A-Za-z0-9_-]+$/;

/** Canonical driver-state sidecar dir. Overridable for tests via DRIVER_STATE_DIR. */
export function driverStateDir(): string {
  return (
    process.env.DRIVER_STATE_DIR ||
    join(homedir(), ".pi", "orchestration-state", "driver-state")
  );
}

/**
 * Read + validate one driver's self-report sidecar. Fail-safe to `null` on any
 * miss (no file, parse error, schema-invalid, path-unsafe name). When
 * `sessionId` is given and the sidecar's `session_id` is present but differs,
 * the sidecar belongs to a prior tenure → `null` (staleness guard).
 */
export function resolveDriverSelfReport(
  name: string | undefined,
  sessionId?: string,
): DriverSelfReport | null {
  if (!name || !NAME_RE.test(name)) return null;
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(join(driverStateDir(), `${name}.json`), "utf8"));
  } catch {
    return null; // no sidecar / unreadable / malformed → fail-safe
  }
  if (!raw || typeof raw !== "object") return null;
  // Staleness guard: a sidecar bound to a different session is a prior tenure's.
  if (sessionId && typeof raw.session_id === "string" && raw.session_id !== sessionId) {
    return null;
  }

  const out: DriverSelfReport = {};

  const p = raw.progress;
  if (p && typeof p === "object" && typeof p.pct === "number" && Number.isFinite(p.pct)) {
    const prog: DriverProgress = { pct: clampPct(p.pct) };
    if (typeof p.label === "string" && p.label.length > 0) prog.label = p.label;
    if (
      Number.isInteger(p.milestones_done) &&
      Number.isInteger(p.milestones_total) &&
      p.milestones_total > 0 &&
      p.milestones_done >= 0 &&
      p.milestones_done <= p.milestones_total
    ) {
      prog.milestonesDone = p.milestones_done;
      prog.milestonesTotal = p.milestones_total;
    }
    out.progress = prog;
  }

  const n = raw.next_engagement;
  if (n && typeof n === "object" && EFFORTS.includes(n.effort)) {
    const ne: DriverNextEngagement = { effort: n.effort };
    if (typeof n.note === "string" && n.note.length > 0) ne.note = n.note;
    out.nextEngagement = ne;
  }

  return out.progress || out.nextEngagement ? out : null;
}

function clampPct(v: number): number {
  return Math.max(0, Math.min(100, Math.round(v)));
}

export interface SelfReportPollDeps {
  /** All known sessions (typically `sessionManager.listAll`). */
  listSessions: () => DashboardSession[];
  /** Resolve a session's canonical driver name (typically via driver-liveness). */
  resolveName: (session: DashboardSession) => string | undefined;
  /** Mutate the canonical session state so new connections see it. */
  applyUpdate: (sessionId: string, updates: Partial<DashboardSession>) => void;
  /** Push the change to connected browsers. */
  broadcast: (sessionId: string, updates: Partial<DashboardSession>) => void;
  /** Poll cadence (ms). Default 15s — human-triage cadence, not real-time. */
  intervalMs?: number;
}

/**
 * Start the self-report poller. Each tick, for every live pi/tmux session,
 * re-reads its sidecar and — only when the (progress, nextEngagement) pair
 * actually changed — applies the update to the manager AND broadcasts it.
 * Fires once immediately so cold-start drivers light up without waiting a tick.
 * Returns a stop handle. The timer is `unref`'d so it never holds the process.
 */
export function startDriverSelfReportPolling(deps: SelfReportPollDeps): () => void {
  const lastBySession = new Map<string, string>();

  const tick = (): void => {
    const liveIds = new Set<string>();
    for (const s of deps.listSessions()) {
      // CC sessions are read-only historical views; ended sessions don't report.
      if (s.source === "claude-code" || s.status === "ended") continue;
      liveIds.add(s.id);
      const name = deps.resolveName(s) ?? s.name;
      const report = resolveDriverSelfReport(name, s.id);
      const progress = report?.progress ?? null;
      const nextEngagement = report?.nextEngagement ?? null;
      const sig = JSON.stringify([progress, nextEngagement]);
      if (lastBySession.get(s.id) === sig) continue; // unchanged → no churn
      lastBySession.set(s.id, sig);
      const updates: Partial<DashboardSession> = { progress, nextEngagement };
      deps.applyUpdate(s.id, updates);
      deps.broadcast(s.id, updates);
    }
    // Forget sessions that ended/disappeared so a re-spawn re-broadcasts.
    for (const id of Array.from(lastBySession.keys())) {
      if (!liveIds.has(id)) lastBySession.delete(id);
    }
  };

  tick(); // immediate — cold-start presence
  const timer = setInterval(tick, deps.intervalMs ?? 15_000);
  if (typeof (timer as any).unref === "function") (timer as any).unref();
  return () => clearInterval(timer);
}
