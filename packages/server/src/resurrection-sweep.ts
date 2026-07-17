/**
 * Component A — ongoing display-resurrection sweep + the shared per-session
 * resurrect action (Lazarus session-resurrection, design-pass §3-A).
 *
 * Layer-1 fix: the proven `resolveDriverLiveness` primitive (driver-liveness.ts,
 * Fix L) is wired startup-only (session-bootstrap.ts:58 + server.ts:319). A
 * session that DIES and is RESUMED *during* server uptime is never re-joined —
 * `endedAt` stays set, pid stays null, the dashboard shows a tombstone while the
 * pi process is alive and interactive in its tmux pane. This sweep closes that
 * coverage gap: a periodic pass re-resolves liveness for every ended pi/tmux row
 * and clears the tombstone when the driver is alive.
 *
 * False-resurrection guard (the load-bearing invariant): resurrection is decided
 * SOLELY by `resolveDriverLiveness` — messenger-registry UUID-join
 * (`registry.sessionId === session.id`) + `kill -0` the registry pid. A
 * genuinely-ended session has no registry entry binding its id (or a dead pid) →
 * `{alive:false}` → STAYS ended. A recycled pid only false-positives if it ALSO
 * carries the exact matching sessionId, which it won't. The sweep NEVER un-ends a
 * session that fails the join.
 *
 * Scope: pi/tmux drivers only. CC (`source==="claude-code"`) rows are correctly
 * ended read-only views and are NEVER resurrected.
 */
import type { SessionManager } from "./memory-session-manager.js";
import type { BrowserGateway } from "./browser-gateway.js";
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import { resolveDriverLiveness, type DriverLiveness } from "./driver-liveness.js";

/** Liveness resolver seam — defaults to the real registry-backed resolver; injectable for tests. */
export type LivenessResolver = (sessionId: string) => DriverLiveness;

export interface ResurrectDeps {
  sessionManager: SessionManager;
  /** Only `broadcastSessionUpdated` is needed — kept narrow so tests can pass a stub. */
  browserGateway: Pick<BrowserGateway, "broadcastSessionUpdated">;
  /** Defaults to `resolveDriverLiveness`. Injected by tests to drive alive/dead deterministically. */
  resolveLiveness?: LivenessResolver;
}

export interface ResurrectResult {
  resurrected: boolean;
  reason: string;
}

/**
 * The shared per-session DISPLAY-resurrect action — reused by the sweep
 * (Component A) and the force-resurrect endpoint's bridge-connected case
 * (Component B, case 1).
 *
 * Resolves liveness; when the driver is alive, clears the tombstone
 * (`status:"idle"`, `endedAt:null`), unhides, rebinds the registry pid, and
 * refreshes the themed name, then broadcasts the update. When NOT alive, it is a
 * no-op and the session STAYS ended (false-resurrection guard).
 *
 * `livenessOverride` lets a caller supply proof-of-life that does NOT come from
 * the messenger registry — specifically Component B case 1, where a live `:9999`
 * bridge is stronger proof than the registry UUID-join (and the session may have
 * no registry entry at all). The sweep omits it, so registry-join remains the
 * sole guard there.
 */
export function resurrectSession(
  id: string,
  deps: ResurrectDeps,
  livenessOverride?: DriverLiveness,
): ResurrectResult {
  const { sessionManager, browserGateway } = deps;
  const resolveLiveness = deps.resolveLiveness ?? resolveDriverLiveness;

  const session = sessionManager.get(id);
  if (!session) return { resurrected: false, reason: "session not found" };
  // CC sessions are correctly ended read-only views — never resurrected.
  if (session.source === "claude-code") {
    return { resurrected: false, reason: "claude-code session (read-only, never resurrected)" };
  }

  const liveness = livenessOverride ?? resolveLiveness(id);
  if (!liveness.alive) {
    // No registry bind, or bound-but-dead pid → genuinely ended. Stays ended.
    return { resurrected: false, reason: "driver not alive (no registry UUID-join or dead pid)" };
  }

  const updates: Partial<DashboardSession> = {
    status: "idle",
    // null (not undefined): the tombstone-clear must survive JSON.stringify to the
    // client, else the client keeps the stale endedAt and re-renders the row ended.
    endedAt: null,
    hidden: false,
  };
  if (typeof liveness.pid === "number") updates.pid = liveness.pid;
  if (liveness.name) updates.name = liveness.name;

  sessionManager.update(id, updates);
  browserGateway.broadcastSessionUpdated(id, updates);
  return { resurrected: true, reason: `driver alive (pid ${liveness.pid ?? "?"})` };
}

export interface ResurrectionSweepDeps extends ResurrectDeps {
  /** Sweep cadence in ms. `<= 0` disables the periodic timer (sweepOnce still callable). */
  intervalMs: number;
}

export interface ResurrectionSweep {
  start(): void;
  stop(): void;
  /** Run a single sweep pass synchronously; returns the count resurrected. Exposed for tests + on-demand. */
  sweepOnce(): number;
}

/**
 * Create the periodic display-resurrection sweep. Iterates ONLY ended pi/tmux
 * rows (`endedAt != null`, non-CC) and runs `resurrectSession` on each — so the
 * `kill -0` cost is paid only over tombstoned rows, never live ones (design-pass
 * §3-A cost note + regression item 10).
 */
export function createResurrectionSweep(deps: ResurrectionSweepDeps): ResurrectionSweep {
  const { sessionManager, intervalMs } = deps;
  let timer: ReturnType<typeof setInterval> | null = null;

  function sweepOnce(): number {
    let resurrected = 0;
    for (const session of sessionManager.listAll()) {
      // Candidate filter: only tombstoned pi/tmux rows. A live row (endedAt
      // null) is skipped — no kill-0 hammer. CC rows are read-only ended views.
      if (session.endedAt == null) continue;
      if (session.source === "claude-code") continue;
      const result = resurrectSession(session.id, deps);
      if (result.resurrected) resurrected++;
    }
    return resurrected;
  }

  return {
    start() {
      if (timer || intervalMs <= 0) return;
      timer = setInterval(() => {
        try {
          sweepOnce();
        } catch (err) {
          console.error("[dashboard] resurrection sweep failed:", err);
        }
      }, intervalMs);
      // Never keep the event loop alive solely for the sweep.
      if (typeof timer.unref === "function") timer.unref();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    sweepOnce,
  };
}
