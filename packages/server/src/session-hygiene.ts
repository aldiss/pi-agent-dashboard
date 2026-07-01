/**
 * Session-row hygiene (dashboard-session-row-hygiene — LOCKED design dl-3397).
 *
 * Pure reconciliation logic shared by the `/api/sessions` read-path (F1 ghost
 * reap, F2 name-canonicalization, F4 CC-pane liveness) and the
 * `POST /api/sessions/retire` endpoint (verify-dead before retire). All I/O is
 * injected via {@link HygieneProbes} so this whole module is unit-testable
 * against in-memory fixtures.
 *
 * ── The 5 invariants (Joan — held in code) ───────────────────────────────
 *  1. LIVE rows are NEVER collapsed/auto-hidden. Two live same-name = an
 *     anomaly SURFACE (the row stays visible), not a cleanup target.
 *  2. Ghosts are hidden-not-deleted behind ONE master switch (the existing
 *     client `showHidden` toggle). Retire == `hidden:true`. No per-name
 *     collapse logic, no ×N badge.
 *  3. Row label is canonical-first: a live driver/pane's clean name overrides
 *     prompt-text / ∅ / stale labels (F2/F4).
 *  4. Liveness predicate is EXPLICIT ({@link verifySessionLive}): live iff a
 *     reachable registry-bound kill-0 pid, OR a verified record pid (kill-0),
 *     OR a live `claude` tmux pane in the session's cwd. NEVER inferred from
 *     name or age.
 *  5. Hiding is presentational only — history + logs stay recoverable.
 *
 * ── ★ The load-bearing retire guard (invariant #1 + #4) ★ ─────────────────
 * {@link evaluateRetire} NEVER trusts the caller's "it's dead" claim. It
 * independently runs {@link verifySessionLive}; if it CANNOT prove the target
 * dead it LEAVES THE ROW LIVE-VISIBLE and flags an anomaly (retire-requested-
 * on-a-LIVE-session = split-brain / cross-fork, the dl-2939 ×4 incident). A
 * careless retire would eat exactly that case.
 */
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import { samePath } from "@blackbelt-technology/pi-dashboard-shared/platform/paths.js";
import type { DriverLiveness } from "./driver-liveness.js";
import type { ClaudePane } from "./cc-pane-liveness.js";

/** Injected I/O — real impls wire registry kill-0 + tmux-pane probe; tests inject fakes. */
export interface HygieneProbes {
  /** Registry sessionId-bind + kill-0 (driver-liveness.ts). The non-CC ground-truth. */
  resolveDriverLiveness: (sessionId: string) => DriverLiveness;
  /** kill(pid, 0) liveness (driver-liveness.ts). The record-pid backstop. */
  pidAlive: (pid: number) => boolean;
  /** Live `claude` tmux panes (cc-pane-liveness.ts). The CC discriminator (F4). */
  listClaudePanes: () => ClaudePane[];
}

/** Structural subset this module reads — keeps fixtures minimal. */
export type HygieneSession = Pick<
  DashboardSession,
  | "id" | "cwd" | "name" | "source" | "status" | "hidden"
  | "pid" | "startedAt" | "endedAt" | "lastActivityAt" | "resuming"
>;

/** Result of the explicit liveness predicate (invariant #4). */
export interface LivenessResult {
  live: boolean;
  /** Which discriminator decided — surfaced in retire anomalies + logs. */
  reason:
    | "cc-pane-alive"
    | "cc-no-pane"
    | "registry-kill0"
    | "pid-kill0"
    | "no-live-bind";
  /** Clean canonical name from the live source (registry name / tmux session-name). */
  cleanName?: string;
  /** Verified-live pid (registry pid or tmux pane pid). */
  pid?: number;
}

/**
 * The single explicit liveness predicate (invariant #4). Used by BOTH the
 * read-path reconciler and the retire-endpoint verify-dead guard so there is
 * exactly ONE definition of "live" in the system.
 *
 * Bias: every live signal is checked before a `false` verdict, so the only way
 * to return dead is to fail ALL of them. A false-positive-live (e.g. a recycled
 * record pid) costs only "row stays visible one more scan" — the
 * invariant-preserving direction (#1: never hide a live row).
 */
export function verifySessionLive(
  session: HygieneSession,
  probes: HygieneProbes,
): LivenessResult {
  // ── CC (source==="claude-code"): tmux-PANE discriminator (F4, dl-2732) ──
  // CC panes run `claude`, have no pi-bridge and no registry entry, so the
  // registry path can't see them. A live `claude` pane whose cwd matches the
  // session's cwd proves it live; the pane's session-name is the clean name.
  if (session.source === "claude-code") {
    const pane = probes.listClaudePanes().find((p) => samePath(p.cwd, session.cwd));
    if (pane) {
      return {
        live: true,
        reason: "cc-pane-alive",
        cleanName: pane.sessionName || undefined,
        pid: pane.pid || undefined,
      };
    }
    return { live: false, reason: "cc-no-pane" };
  }

  // ── non-CC (pi / tmux driver): registry kill-0 ground-truth (F1) ──
  const dl = probes.resolveDriverLiveness(session.id);
  if (dl.alive) {
    // W4 name-canon: pin > derived. The operator-pinned name (operatorPinnedName)
    // is canonical over the auto-derived registry `name`, completing the class-3
    // fix (F2-read + F5-write). See change: name-sync-write-pin.
    return { live: true, reason: "registry-kill0", cleanName: dl.operatorPinnedName ?? dl.name };
  }
  // Record-pid backstop: a session carrying its own kill-0-alive pid is live
  // even without a registry bind (invariant #4: "OR verified current pid").
  // This is the cross-fork guard — a live cross-wired row has a live pid, so
  // the retire endpoint refuses to hide it.
  if (typeof session.pid === "number" && probes.pidAlive(session.pid)) {
    return { live: true, reason: "pid-kill0", pid: session.pid };
  }
  return { live: false, reason: "no-live-bind" };
}

/** Best timestamp basis for "how long since this session was last alive". */
function sessionAgeBasis(s: HygieneSession): number {
  return s.endedAt ?? s.lastActivityAt ?? s.startedAt ?? 0;
}

/** True iff the session has been quiet at least `graceMs` (0 = no grace). */
function agedOut(s: HygieneSession, nowMs: number, graceMs: number): boolean {
  if (graceMs <= 0) return true;
  const basis = sessionAgeBasis(s);
  if (!basis) return true;
  return nowMs - basis >= graceMs;
}

/** One reconciliation action: persist `updates` onto the session + broadcast. */
export interface HygieneAction {
  sessionId: string;
  updates: Partial<DashboardSession>;
  /** Why — for diagnostics/logging. */
  reason: string;
}

export interface ReconcileOpts {
  nowMs: number;
  /** Grace window before a verified-dead ended row is auto-retired. */
  graceMs?: number;
}

/**
 * F1 + F2 + F4 read-path reconciliation. Returns the idempotent set of updates
 * to apply to the in-memory sessions (the caller persists + broadcasts). A
 * second call with the same inputs returns `[]` (everything already applied).
 *
 *   LIVE  → F2/F4 canonical name override; rescue a false-ended row to
 *           idle+visible (the dl-2929 live→false-ended direction).
 *   DEAD  → F1 reap: an `ended`, aged-out, not-yet-hidden, not-resuming row is
 *           retired (`hidden:true`) — hidden-not-deleted behind the master
 *           toggle. Live rows are NEVER reaped (invariant #1).
 */
export function reconcileSessionHygiene(
  sessions: HygieneSession[],
  probes: HygieneProbes,
  opts: ReconcileOpts,
): HygieneAction[] {
  const graceMs = opts.graceMs ?? 0;
  const actions: HygieneAction[] = [];

  for (const s of sessions) {
    const live = verifySessionLive(s, probes);

    if (live.live) {
      const updates: Partial<DashboardSession> = {};
      // F2/F4 — canonical-first label (kill ∅ / prompt-text / stale name).
      if (live.cleanName && live.cleanName !== s.name) updates.name = live.cleanName;
      // F1/F4 — rescue a false-ended-while-alive row (same root as restore).
      if (s.status === "ended") {
        updates.status = "idle";
        updates.hidden = false;
      }
      // Capture the verified pid (esp. CC pane pid) so a later retire can
      // verify-dead against a real pid.
      if (live.pid && live.pid !== s.pid) updates.pid = live.pid;
      if (Object.keys(updates).length > 0) {
        actions.push({ sessionId: s.id, updates, reason: `live:${live.reason}` });
      }
      continue;
    }

    // DEAD — F1 reap (hidden-not-deleted). Only ended, aged-out, visible,
    // non-resuming rows. Never an active/idle row (those aren't "ended" so the
    // status gate already protects them).
    if (s.status === "ended" && !s.hidden && !s.resuming && agedOut(s, opts.nowMs, graceMs)) {
      actions.push({ sessionId: s.id, updates: { hidden: true }, reason: `reap:${live.reason}` });
    }
  }

  return actions;
}

// ─────────────────────────────────────────────────────────────────────────
//  Retire endpoint (POST /api/sessions/retire) — verify-dead guard.
// ─────────────────────────────────────────────────────────────────────────

/** Multi-key retire request body. Caller passes whatever it just killed. */
export interface RetireKey {
  sessionId?: string;
  tmuxName?: string;
  pid?: number;
}

/**
 * Resolve the in-memory session record(s) a retire key points at — name + pid
 * come from the record, NO JSONL/registry read (race-free). OR-semantics
 * across provided keys. May return >1 (the 26-Joans duplicate case): each is
 * then verified-dead independently so a live dupe is never hidden by a sibling.
 */
export function resolveRetireTargets(
  sessions: HygieneSession[],
  key: RetireKey,
): HygieneSession[] {
  const out: HygieneSession[] = [];
  for (const s of sessions) {
    if (key.sessionId && s.id === key.sessionId) { out.push(s); continue; }
    if (key.tmuxName && s.name === key.tmuxName) { out.push(s); continue; }
    if (typeof key.pid === "number" && s.pid === key.pid) { out.push(s); continue; }
  }
  return out;
}

/** A target the endpoint REFUSED to retire because it proved LIVE (anomaly). */
export interface RefusedLive {
  sessionId: string;
  name?: string;
  reason: string;
}

/** The retire decision. Always non-fatal for the caller (best-effort). */
export interface RetireDecision {
  /** sessionIds proven-dead and retired (caller hides + broadcasts these). */
  retired: string[];
  /** Live targets the guard REFUSED to hide — invariant #1 anomaly surface. */
  refusedLive: RefusedLive[];
  /** No record matched AND no live key-signal — a benign miss (F1 backstop covers it). */
  notFound: boolean;
  /** True iff `refusedLive` is non-empty (split-brain / cross-fork detected). */
  anomaly: boolean;
}

/** Does the bare key prove something live exists, even with no record match? */
function keyProvesLive(key: RetireKey, probes: HygieneProbes): string | null {
  if (typeof key.pid === "number" && probes.pidAlive(key.pid)) return "pid-kill0";
  if (key.tmuxName && probes.listClaudePanes().some((p) => p.sessionName === key.tmuxName)) {
    return "cc-pane-name-alive";
  }
  return null;
}

/**
 * ★ The load-bearing retire guard (invariant #1 + #4). ★
 *
 * For each resolved target, independently {@link verifySessionLive}; retire
 * ONLY the proven-dead. Any target that is — or whose key proves — LIVE is
 * REFUSED and surfaced as an anomaly; its row stays live-visible. NEVER trusts
 * the caller's confirmed-dead claim.
 */
export function evaluateRetire(
  sessions: HygieneSession[],
  key: RetireKey,
  probes: HygieneProbes,
): RetireDecision {
  const targets = resolveRetireTargets(sessions, key);
  const retired: string[] = [];
  const refusedLive: RefusedLive[] = [];

  if (targets.length === 0) {
    // No in-memory record. The key might still prove a LIVE thing exists
    // (cross-fork where this server doesn't track the row) — surface it,
    // never silently succeed.
    const liveReason = keyProvesLive(key, probes);
    if (liveReason) {
      return { retired, refusedLive: [{ sessionId: "", reason: liveReason }], notFound: false, anomaly: true };
    }
    return { retired, refusedLive, notFound: true, anomaly: false };
  }

  for (const t of targets) {
    const live = verifySessionLive(t, probes);
    // Belt: even if `t` matched by id/pid, a requested tmuxName naming a live
    // pane is an independent live-signal (CC record may still carry prompt-text).
    const paneNameLive =
      !!key.tmuxName && probes.listClaudePanes().some((p) => p.sessionName === key.tmuxName);
    if (live.live || paneNameLive) {
      refusedLive.push({
        sessionId: t.id,
        name: t.name,
        reason: live.live ? live.reason : "cc-pane-name-alive",
      });
    } else {
      retired.push(t.id);
    }
  }

  return { retired, refusedLive, notFound: false, anomaly: refusedLive.length > 0 };
}
