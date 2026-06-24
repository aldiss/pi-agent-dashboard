/**
 * Runtime session rescan + liveness re-resolution (handover-reliability WI-1).
 *
 * The dashboard only learns sessions at BOOT: `scanAllSessions()` and the
 * Fix-L liveness resolution both run once in `createServer`. A session that
 * registers POST-boot and never reaches the bridge (class-1), or a driver that
 * goes `ended` post-boot via `unregister()` while its process is still alive
 * (class-2), is therefore wrong until the next server restart.
 *
 * This module runs that same scan + liveness pass on a ~15s timer (and on an
 * explicit rotation-detected `tick()` from the orchestration half), so:
 *
 *  - Phase 1 (class-1 VISIBILITY): a scanned session ABSENT from the registry
 *    is merged in via the GUARDED `sessionManager.restore()` (invariant I5 —
 *    it never clobbers a live/active row). Boot-equivalent Fix-L liveness is
 *    applied at merge time so an absent-but-alive driver merges in idle+visible.
 *
 *  - Phase 2 (class-2 LIVENESS-TRUTH, WI-3 folded in): every existing pi/tmux
 *    row that is `ended` is re-resolved against the messenger registry (kill-0).
 *    A row whose pid is alive flips `ended → idle` + clean registry name. CC
 *    rows are never touched (read-only historical views).
 *
 *  - Invariant I6 (cross-guard): if flipping an ended PREDECESSOR back to idle
 *    would produce a SECOND live card with the same role-name as an existing
 *    live SUCCESSOR, the predecessor is NOT flipped — it is left ended+hidden
 *    and SURFACED for reap (`stale_predecessor_surfaced`). This code raises the
 *    signal; the orchestration half (Steward S6/S7) performs the reap.
 *
 *  - Phase 2.5 (dedup trigger-b, Perf↔Steward seam-finalization): a SEPARATE
 *    detection pass over the already-non-ended row-set. Two-or-more live rows
 *    that resolve to the SAME canonical identity (no liveness-flip involved —
 *    e.g. Lane-8 + Lane-9 both already idle) are deduped DETERMINISTICALLY by
 *    the discriminator: dashboard `startedAt` is PRIMARY (newest = successor;
 *    all-older = `stale_predecessor_surfaced`). The role-registry `session_id`
 *    is an OPTIONAL corroborator ONLY when populated (empty for almost everyone
 *    — never the primary key). Two guards make this safe against the live
 *    4-registries-disagree reality (role-registry empty, messenger missing,
 *    tmux stale, dashboard 2 rows):
 *      · GUARD-1 (grouping-key): a row with a null/empty name is NOT grouped on
 *        name. Canonical identity resolves by priority — messenger-registry name
 *        → tmux-pane role-prefix → within-cwd startedAt-cluster. A row no source
 *        can resolve is left UNGROUPED (never auto-grouped on a guess).
 *      · GUARD-2 (identity_incoherent escape-hatch, LOAD-BEARING): when a group
 *        forms but the successor CANNOT be picked deterministically (equal/
 *        missing startedAt, registries actively disagree, or the group was only
 *        formed by the low-confidence cwd-cluster fallback) the code does NOT
 *        guess a reapCandidate — it emits `identity_incoherent` and leaves the
 *        decision to the orchestration/operator. Deterministic-dedup the CLEAN
 *        case; SURFACE the incoherent case; NEVER auto-guess.
 *
 * Every step emits a structured §4 event through an injectable sink (default:
 * console + a tail-able log file). This is a transparent merge, never silent.
 *
 * See contract: deterministic-handover-state-machine-contract-v0 §6 WI-1,
 * invariants I2/I4/I5/I6. See change: handover-reliability-wi1.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import type { SessionManager } from "./memory-session-manager.js";
import { scanAllSessions } from "./session-scanner.js";
import { createLivenessSnapshot, type DriverLiveness } from "./driver-liveness.js";

/** One structured rescan step-event (§4 of the contract). */
export type RescanEvent =
  | { ts: string; type: "rescan_started"; reason: string; scanned: number }
  | { ts: string; type: "row_merged"; id: string; reason: "absent" | "existing-ended"; status: DashboardSession["status"] }
  | { ts: string; type: "row_skipped"; id: string; reason: "live-active-guard" }
  | { ts: string; type: "liveness_reresolved"; id: string; kill0: "alive"; flippedTo: "idle"; name?: string }
  | {
      ts: string;
      type: "stale_predecessor_surfaced";
      id: string;
      name: string;
      successorId: string;
      /** Which dedup trigger raised this: (a) a liveness flip would duplicate a
       *  live successor, or (b) two-or-more already-live rows share a name. */
      trigger: "liveness-flip" | "same-name-multi-live";
    }
  | {
      ts: string;
      type: "identity_incoherent";
      /** The canonical role name or the cwd-cluster key the group formed on. */
      roleOrCluster: string;
      /** Every row id in the ambiguous group — the orchestration/operator picks. */
      candidateIds: string[];
      /** Why the successor could not be picked deterministically. */
      reason: string;
    }
  | { ts: string; type: "rescan_complete"; merged: number; skipped: number; flipped: number; surfaced: number; incoherent: number };

export interface RescanSummary {
  scanned: number;
  /** absent rows merged in via the guarded restore (class-1 fix). */
  merged: number;
  /** scanned rows skipped because a live/active row already holds the id (I5). */
  skipped: number;
  /** existing ended pi/tmux rows flipped ended→idle by liveness (class-2 fix). */
  flipped: number;
  /** stale predecessors surfaced for reap — triggers (a)+(b) combined (I6). */
  surfaced: number;
  /** ambiguous identity groups surfaced via the GUARD-2 escape-hatch (no guess). */
  incoherent: number;
}

export interface SessionRescannerDeps {
  sessionManager: SessionManager;
  /** Broadcast a newly-merged (absent) row to browsers. Mirrors session-bootstrap. */
  broadcastSessionAdded: (session: DashboardSession) => void;
  /** Broadcast a liveness flip (ended→idle) to browsers. */
  broadcastSessionUpdated: (sessionId: string, updates: Partial<DashboardSession>) => void;
  /** Source of scanned sessions. Default: `scanAllSessions().sessions`. Injectable for tests. */
  scan?: () => DashboardSession[];
  /** Build a one-shot liveness snapshot. Default: `createLivenessSnapshot`. Injectable for tests. */
  makeLivenessSnapshot?: () => (sessionId: string) => DriverLiveness;
  /**
   * GUARD-1 fallback (ii): map a row's sessionId to a tmux-pane role-prefix
   * (e.g. "Lane") when its dashboard name is null/empty. Default: () => null
   * (no-op). The live `~/.tmux/pi-sessions.json` is known-stale (Perf own-hand:
   * lane-8 id mismatch + lane-9 absent), so the default deliberately does NOT
   * read it — a wrong tmux map would mis-group. Wiring a verified-fresh tmux
   * resolver is a follow-on coordinated with the tmux-state owner. Injectable
   * for tests so GUARD-1's resolve-or-leave-ungrouped contract is provable.
   */
  tmuxRoleOf?: (sessionId: string) => string | null;
  /**
   * Discriminator corroborator: the role-registry's canonical `session_id` for
   * a role name, when populated. OPTIONAL — it is empty for almost everyone, so
   * it NEVER picks the successor alone; it only flips a group to
   * `identity_incoherent` when it actively DISAGREES with the startedAt winner.
   * Default: () => null (no corroboration; startedAt stands alone).
   */
  roleRegistrySessionId?: (roleName: string) => string | null;
  /** Step-event sink. Default: console + tail-able log file. Injectable for tests. */
  sink?: (event: RescanEvent) => void;
  /** Periodic floor between ticks (ms). Default 15000. */
  intervalMs?: number;
  /** Clock. Default `Date.now`. Injectable for deterministic test timestamps. */
  now?: () => number;
}

export interface SessionRescanner {
  /** Run one full rescan + liveness pass. Synchronous. Safe to call from the timer or an event. */
  tick(reason: string): RescanSummary;
  /** Start the periodic floor timer. Idempotent. */
  start(): void;
  /** Stop the periodic floor timer. Idempotent. */
  stop(): void;
}

/** Default tail-able rescan log path. */
function defaultLogPath(): string {
  return join(homedir(), ".pi", "dashboard", "handover-rescan.log");
}

/** Default sink: a compact console line + an appended JSON line to the tail-able log. */
function defaultSink(event: RescanEvent): void {
  // Compact operator-readable console line.
  console.log(`[rescan] ${event.type} ${JSON.stringify(event)}`);
  try {
    const path = defaultLogPath();
    mkdirSync(join(homedir(), ".pi", "dashboard"), { recursive: true });
    appendFileSync(path, JSON.stringify(event) + "\n");
  } catch {
    // Log-only durability; never let a logging failure break the rescan.
  }
}

/**
 * GUARD-1 canonical-identity resolution for the dedup trigger-b pass.
 *
 * Returns the grouping KEY for a row plus the `basis` that produced it, or null
 * when no source can resolve the row (→ it is left UNGROUPED, never guessed).
 * Priority:
 *   (registry) messenger-registry name when the row's sessionId resolves there
 *   (name)     the row's own non-empty dashboard name
 *   (tmux)     a tmux-pane role-prefix for the row's sessionId
 *   — name/registry/tmux all share the `role:<name>` keyspace so a name-null
 *     row resolved via tmux groups with an identically-named explicit row.
 * The low-confidence cwd-cluster fallback is applied separately (it needs the
 * whole row-set, not a single row) and always forces GUARD-2.
 */
export function canonicalIdentity(
  row: Pick<DashboardSession, "id" | "name">,
  liveness: (sessionId: string) => DriverLiveness,
  tmuxRoleOf: (sessionId: string) => string | null,
): { key: string; display: string; basis: "registry" | "name" | "tmux" } | null {
  // (i) messenger-registry name — only when alive AND it carries a clean name.
  const live = liveness(row.id);
  if (live.alive && typeof live.name === "string" && live.name) {
    return { key: `role:${live.name}`, display: live.name, basis: "registry" };
  }
  // (ii) the row's own explicit name.
  if (typeof row.name === "string" && row.name) {
    return { key: `role:${row.name}`, display: row.name, basis: "name" };
  }
  // (iii) tmux-pane role-prefix (default no-op → null; injected in tests / when
  // a verified-fresh tmux map is wired).
  const tmux = tmuxRoleOf(row.id);
  if (typeof tmux === "string" && tmux) {
    return { key: `role:${tmux}`, display: tmux, basis: "tmux" };
  }
  // Unresolvable → NOT grouped (GUARD-1).
  return null;
}

export interface DiscriminateDeps {
  /** Optional role-registry corroborator (empty for almost everyone). */
  roleRegistrySessionId: (roleName: string) => string | null;
}

/**
 * The seam-locked discriminator + GUARD-2 escape-hatch for one same-identity
 * group of ≥2 non-ended rows.
 *
 * Returns either a deterministic decision (one successor, the rest are stale
 * predecessors) or an `incoherent` verdict carrying the reason. NEVER guesses.
 *
 * Rules:
 *   - PRIMARY = dashboard `startedAt`: the single newest row is the successor.
 *   - A group formed only by the low-confidence `cwd-cluster` fallback is
 *     ALWAYS incoherent (cwd alone is not an identity).
 *   - Equal-or-missing startedAt at the top (no unique newest) → incoherent.
 *   - role-registry `session_id` populated AND ≠ the startedAt winner (and the
 *     registry id IS one of the candidates) → registries disagree → incoherent.
 */
export function discriminateGroup(
  rows: DashboardSession[],
  basis: "registry" | "name" | "tmux" | "cwd-cluster",
  display: string,
  deps: DiscriminateDeps,
): { kind: "decided"; successor: DashboardSession; predecessors: DashboardSession[] } | { kind: "incoherent"; reason: string } {
  // cwd-cluster basis is never confident enough to auto-reap.
  if (basis === "cwd-cluster") {
    return { kind: "incoherent", reason: "grouped only by cwd-cluster fallback (no canonical name)" };
  }
  // Sort by startedAt descending; undefined sorts last (treated as oldest).
  const sorted = [...rows].sort((a, b) => (b.startedAt ?? -Infinity) - (a.startedAt ?? -Infinity));
  const newest = sorted[0];
  const second = sorted[1];
  // No unique newest: top startedAt missing, or tied with the runner-up.
  if (newest.startedAt === undefined) {
    return { kind: "incoherent", reason: "newest row has no startedAt (cannot order)" };
  }
  if (second && second.startedAt === newest.startedAt) {
    return { kind: "incoherent", reason: `startedAt tie at ${newest.startedAt} (no unique newest)` };
  }
  // Optional corroborator: if the role-registry names a canonical session_id
  // that is in this group but is NOT the startedAt winner, the registries
  // actively disagree → surface, do not guess.
  const registryId = deps.roleRegistrySessionId(display);
  if (registryId && registryId !== newest.id && rows.some((r) => r.id === registryId)) {
    return { kind: "incoherent", reason: `role-registry session_id ${registryId} disagrees with startedAt winner ${newest.id}` };
  }
  return { kind: "decided", successor: newest, predecessors: sorted.slice(1) };
}

export function createSessionRescanner(deps: SessionRescannerDeps): SessionRescanner {
  const {
    sessionManager,
    broadcastSessionAdded,
    broadcastSessionUpdated,
    scan = () => scanAllSessions().sessions,
    makeLivenessSnapshot = createLivenessSnapshot,
    tmuxRoleOf = () => null,
    roleRegistrySessionId = () => null,
    sink = defaultSink,
    intervalMs = 15_000,
    now = Date.now,
  } = deps;

  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  function emit(event: RescanEvent): void {
    try {
      sink(event);
    } catch {
      // A faulty sink must never break the rescan loop.
    }
  }

  function tick(reason: string): RescanSummary {
    const summary: RescanSummary = { scanned: 0, merged: 0, skipped: 0, flipped: 0, surfaced: 0, incoherent: 0 };
    // Fully-synchronous body; this guard is defensive documentation of intent.
    if (running) return summary;
    running = true;
    try {
      const ts = () => new Date(now()).toISOString();
      // One registry snapshot for the whole tick (collapses N readdirs → 1).
      const liveness = makeLivenessSnapshot();

      const scanned = scan();
      summary.scanned = scanned.length;
      emit({ ts: ts(), type: "rescan_started", reason, scanned: scanned.length });

      // ── Phase 1 — class-1 VISIBILITY: merge ABSENT rows (guarded by I5) ──
      for (const row of scanned) {
        const existing = sessionManager.get(row.id);
        if (existing) {
          // Present already. A live/active row must never be clobbered (I5).
          if (existing.status !== "ended") {
            emit({ ts: ts(), type: "row_skipped", id: row.id, reason: "live-active-guard" });
            summary.skipped++;
          }
          // Present-and-ended rows are left to Phase 2's in-place liveness pass
          // (re-merging the stale scan snapshot would clobber registry-clean
          // name / unread bit). No-op here.
          continue;
        }
        // Absent → merge in. Apply boot-equivalent Fix-L liveness at merge time
        // so an absent-but-alive pi/tmux driver lands idle+visible, not ended.
        const merged: DashboardSession = { ...row };
        if (merged.source !== "claude-code" && merged.status === "ended") {
          const live = liveness(merged.id);
          if (live.alive) {
            merged.status = "idle";
            merged.hidden = false;
            if (live.name) merged.name = live.name;
          }
        }
        const result = sessionManager.restore(merged);
        if (result.applied) {
          const stored = sessionManager.get(merged.id);
          if (stored) broadcastSessionAdded(stored);
          emit({ ts: ts(), type: "row_merged", id: merged.id, reason: result.reason as "absent" | "existing-ended", status: merged.status });
          summary.merged++;
        } else {
          // Raced into existence as live between get() and restore() — guard held.
          emit({ ts: ts(), type: "row_skipped", id: merged.id, reason: "live-active-guard" });
          summary.skipped++;
        }
      }

      // ── Phase 2 — class-2 LIVENESS-TRUTH: re-resolve EXISTING ended pi/tmux ──
      // Seed the set of role-names already held by a LIVE card (post Phase-1),
      // so I6 can detect a predecessor that would duplicate a live successor.
      const liveNames = new Set<string>();
      for (const s of sessionManager.listAll()) {
        if (s.status !== "ended" && typeof s.name === "string" && s.name) liveNames.add(s.name);
      }

      for (const row of sessionManager.listAll()) {
        // CC rows stay ended+read-only; only ended rows are candidates.
        if (row.source === "claude-code" || row.status !== "ended") continue;
        const live = liveness(row.id);
        if (!live.alive) continue; // genuinely dead → stays ended (no event — avoid per-tick noise)

        const cleanName = live.name ?? row.name;
        // I6 cross-guard: flipping this predecessor would create a 2nd live card
        // with the same role-name as an existing live successor. Surface, don't flip.
        if (typeof cleanName === "string" && cleanName && liveNames.has(cleanName)) {
          const successor = sessionManager
            .listAll()
            .find((s) => s.id !== row.id && s.status !== "ended" && s.name === cleanName);
          emit({
            ts: ts(),
            type: "stale_predecessor_surfaced",
            id: row.id,
            name: cleanName,
            successorId: successor?.id ?? "",
            trigger: "liveness-flip",
          });
          summary.surfaced++;
          continue;
        }

        // No collision → flip ended → idle + clean registry name (class-2 fix).
        const updates: Partial<DashboardSession> = { status: "idle", hidden: false };
        if (live.name) updates.name = live.name;
        sessionManager.update(row.id, updates);
        broadcastSessionUpdated(row.id, updates);
        if (typeof cleanName === "string" && cleanName) liveNames.add(cleanName);
        emit({ ts: ts(), type: "liveness_reresolved", id: row.id, kill0: "alive", flippedTo: "idle", name: live.name });
        summary.flipped++;
      }

      // ── Phase 2.5 — dedup trigger-b: same-name multi-live (no flip) ──
      // A SEPARATE detection pass over the CURRENT non-ended row-set. Group by
      // canonical identity (GUARD-1), then deterministically keep the newest
      // startedAt and surface all-older for reap — or, when the successor is not
      // determinable, emit identity_incoherent (GUARD-2) instead of guessing.
      const nonEnded = sessionManager
        .listAll()
        .filter((s) => s.source !== "claude-code" && s.status !== "ended");

      // Build canonical-identity groups (registry/name/tmux basis).
      const groups = new Map<string, { display: string; basis: "registry" | "name" | "tmux"; rows: DashboardSession[] }>();
      const ungrouped: DashboardSession[] = [];
      for (const row of nonEnded) {
        const ident = canonicalIdentity(row, liveness, tmuxRoleOf);
        if (!ident) {
          ungrouped.push(row); // GUARD-1: no canonical identity → not name-grouped
          continue;
        }
        const g = groups.get(ident.key);
        if (g) g.rows.push(row);
        else groups.set(ident.key, { display: ident.display, basis: ident.basis, rows: [row] });
      }

      // Last-resort cwd-cluster fallback for the name-unresolvable rows: only a
      // cluster of ≥2 rows sharing a cwd forms a (low-confidence) group, which
      // GUARD-2 then always routes to identity_incoherent.
      const byCwd = new Map<string, DashboardSession[]>();
      for (const row of ungrouped) {
        const key = row.sessionDir ?? row.cwd ?? "";
        if (!key) continue;
        const arr = byCwd.get(key);
        if (arr) arr.push(row);
        else byCwd.set(key, [row]);
      }

      // Evaluate every multi-member group through the seam-locked discriminator.
      type Eval = { rows: DashboardSession[]; basis: "registry" | "name" | "tmux" | "cwd-cluster"; display: string };
      const candidates: Eval[] = [];
      for (const g of groups.values()) {
        if (g.rows.length >= 2) candidates.push({ rows: g.rows, basis: g.basis, display: g.display });
      }
      for (const [key, rows] of byCwd.entries()) {
        if (rows.length >= 2) candidates.push({ rows, basis: "cwd-cluster", display: `cwd:${key}` });
      }

      for (const cand of candidates) {
        const verdict = discriminateGroup(cand.rows, cand.basis, cand.display, { roleRegistrySessionId });
        if (verdict.kind === "incoherent") {
          emit({
            ts: ts(),
            type: "identity_incoherent",
            roleOrCluster: cand.display,
            candidateIds: cand.rows.map((r) => r.id),
            reason: verdict.reason,
          });
          summary.incoherent++;
          continue;
        }
        // Deterministic clean case: keep the newest, surface all-older for reap.
        for (const pred of verdict.predecessors) {
          emit({
            ts: ts(),
            type: "stale_predecessor_surfaced",
            id: pred.id,
            name: cand.display,
            successorId: verdict.successor.id,
            trigger: "same-name-multi-live",
          });
          summary.surfaced++;
        }
      }

      emit({
        ts: ts(),
        type: "rescan_complete",
        merged: summary.merged,
        skipped: summary.skipped,
        flipped: summary.flipped,
        surfaced: summary.surfaced,
        incoherent: summary.incoherent,
      });
      return summary;
    } finally {
      running = false;
    }
  }

  return {
    tick,
    start() {
      if (timer) return;
      // unref so the periodic floor never holds the process open on its own.
      timer = setInterval(() => tick("periodic"), intervalMs);
      if (typeof timer.unref === "function") timer.unref();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
