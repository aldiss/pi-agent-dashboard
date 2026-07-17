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
  /**
   * Live tmux SESSION names (cc-pane-liveness.ts listDriverTmuxSessions). The
   * pi-driver liveness axis: a REG-absent driver with a null row-pid still runs
   * in a tmux session named after its mesh name. Optional — absent in older
   * fixtures → verifySessionLive skips the tmux axis (still fail-safe: a row is
   * only demoted when registry AND record-pid are ALSO dead).
   */
  listDriverTmuxSessions?: () => string[];
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
    | "tmux-session-alive"
    | "tmux-name-superseded"
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
    // Claude-PID backstop (build-2 P0 fix #4). A CC session carrying its own
    // kill-0-alive pid is LIVE even without a matching `claude` pane — the pane
    // list can be stale, the pane may run in a cwd we can't resolve, or the
    // process may be SIGSTOP'd (kill-0 still succeeds on a stopped process).
    // Without this, retire/hygiene would mark a kill-0-alive CC target dead (the
    // kill-0 hole). Never mark an unverified-live CC target dead: only a CC
    // session with NO pane AND no kill-0-alive pid is a proven-dead `cc-no-pane`.
    if (typeof session.pid === "number" && probes.pidAlive(session.pid)) {
      return { live: true, reason: "pid-kill0", pid: session.pid };
    }
    return { live: false, reason: "cc-no-pane" };
  }

  // ── non-CC (pi / tmux driver): registry kill-0 ground-truth (F1) ──
  const dl = probes.resolveDriverLiveness(session.id);
  if (dl.alive) {
    // W4 name-canon: use the registry's clean themed-name. (operatorPinnedName —
    // the operator-pinned override — is intentionally NOT read here: it has a
    // separate known write-bug (dl-4706) where the mesh status-string bleeds into
    // the pin-slot on resume. Deferred to that targeted fix + the full DriverLiveness
    // contract; de-ghosting does not need it, and dl.name sidesteps the corruption.)
    return { live: true, reason: "registry-kill0", cleanName: dl.name };
  }
  // Record-pid backstop: a session carrying its own kill-0-alive pid is live
  // even without a registry bind (invariant #4: "OR verified current pid").
  // This is the cross-fork guard — a live cross-wired row has a live pid, so
  // the retire endpoint refuses to hide it.
  if (typeof session.pid === "number" && probes.pidAlive(session.pid)) {
    return { live: true, reason: "pid-kill0", pid: session.pid };
  }
  // ── tmux-SESSION liveness (the third axis, symmetric to the CC-pane path) ──
  // A live-but-unregistered pi-driver whose row carries NO record-pid still runs
  // in a live tmux session named after its mesh name (spawn-driver names it so).
  // Match by session-NAME, not cwd: pi-drivers co-locate cwds (orchestration-
  // state, worktrees), so a cwd-match would false-KEEP a ghost sharing a live
  // driver's cwd. EXACT name-match binds to THE driver — and it also correctly
  // does NOT keep a superseded lineage row ("Conductor" ∉ ["Conductor-2"]).
  // Fail-safe: no probe / no match → fall through to the dead verdict.
  const nameToken = driverNameToken(session.name);
  if (nameToken && (probes.listDriverTmuxSessions?.() ?? []).includes(nameToken)) {
    return { live: true, reason: "tmux-session-alive", cleanName: nameToken };
  }
  return { live: false, reason: "no-live-bind" };
}

/**
 * Extract the driver's mesh-name token from a (possibly status-suffixed) row
 * name. The tmux session-name is the leading whitespace-delimited token
 * ("Conductor — <status>" → "Conductor"); hyphens WITHIN a token are preserved
 * ("rotation-root-fix" stays whole). Empty when the row has no name.
 */
function driverNameToken(name: string | undefined): string {
  if (!name) return "";
  return name.trim().split(/\s+/)[0] ?? "";
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

/**
 * Minimum quiet-window before a `tmux-name-superseded` ghost is demoted, applied
 * EVEN when the caller passes graceMs:0 (the prod sweep + read-path both do). A
 * superseded verdict is HEURISTIC (no strong proof-of-death — the row was demoted
 * only because a same-name sibling owns the unique live tmux), so it earns a grace
 * a strong-proven-dead row does not: a recently-active record is never immediately
 * hidden. Real ghosts (idle for many minutes / hours / days) are far past this, so
 * board cleanup is unaffected; the belt only protects the degenerate two-same-name-
 * live anomaly (a genuinely-live tmux-only driver colliding a strong sibling's
 * name) — the one invariant-#1 residual of the weak-axis disambiguation.
 */
const SUPERSEDED_DEMOTE_MIN_GRACE_MS = 120_000;

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
  /**
   * True while inside the post-restart grace window (nowMs - serverStartMs <
   * postRestartGraceMs). During it the sweep does NOTHING — a live driver whose
   * registry/bridge has not yet re-populated after a (re)start would transiently
   * read dead, so ALL demotion/reap is forbidden until the window passes
   * (Conductor-2 safety-envelope #3; force-unknown, no mutation).
   */
  withinPostRestartGrace?: boolean;
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

  // Post-restart grace (envelope #3): force-unknown — no mutation while the
  // registry/bridge may still be re-populating after a (re)start, so a fresh
  // restart never demotes a live-but-not-yet-re-registered driver.
  if (opts.withinPostRestartGrace) return actions;

  // ── Probe memoization (perf; dl-4820 read-path latency) ─────────────────
  // verifySessionLive() calls listDriverTmuxSessions()/listClaudePanes() on every
  // record that reaches the tmux/CC axes. Over the full fleet (~500 rows) each
  // UNCACHED probe re-shells `tmux list-sessions`, so the /api/sessions read-path
  // measured ~20-27s. Both probes are pass-invariant (one tmux/pane snapshot per
  // reconcile), so snapshot each ONCE here and hand verifySessionLive memoized
  // readers. Registry/pid probes stay per-record (they are sessionId/pid-specific).
  const tmuxSnapshot = probes.listDriverTmuxSessions?.() ?? [];
  const paneSnapshot = probes.listClaudePanes();
  const memoProbes: HygieneProbes = {
    ...probes,
    listDriverTmuxSessions: () => tmuxSnapshot,
    listClaudePanes: () => paneSnapshot,
  };

  // ── Liveness (one pass) + tmux name-token disambiguation ────────────────
  // A tmux session-name is UNIQUE, so a live tmux "Alice" is attributable to
  // exactly ONE driver. verifySessionLive's tmux axis matches by name-token only,
  // so a single live "Alice" tmux keeps EVERY same-name null-pid record visible
  // (the 9-Alice over-keep: 1 live Alice + 8 dead ghosts, all kept). Fix: if a
  // same-name record is live via a STRONG axis (registry-kill0 / pid-kill0 /
  // cc-pane-alive), the unique tmux belongs to THAT record — so a same-name record
  // kept ONLY by the weak tmux name-axis is a dead ghost and is demoted.
  // False-demote-safe (invariant #1): (a) a genuinely-live null-pid tmux driver
  // with NO strong same-name sibling keeps its tmux-axis liveness (its name is not
  // strong-claimed); (b) a superseded record is one BORROWING a strong sibling's
  // UNIQUE tmux name, so it is structurally a ghost (a real driver owns its own
  // unique tmux). NOTE the prod sweep passes graceMs:0, so the ordinary agedOut()
  // is a no-op and a superseded-demote would otherwise be IMMEDIATE; the dead-
  // handling below therefore applies a dedicated SUPERSEDED_DEMOTE_MIN_GRACE_MS
  // belt to the superseded case, so a recently-active row in the degenerate
  // two-same-name-live anomaly is never immediately hidden.
  const results = sessions.map((s) => ({ s, live: verifySessionLive(s, memoProbes) }));
  const strongLiveNames = new Set<string>();
  for (const { s, live } of results) {
    if (live.live && live.reason !== "tmux-session-alive") {
      // Use the clean mesh-name (registry/cc-pane name = the tmux session-name)
      // when present, else the record label. This is the token the ghosts' tmux
      // match against, so a registry-live row with a stale label still supersedes.
      const tok = driverNameToken(live.cleanName ?? s.name);
      if (tok) strongLiveNames.add(tok);
    }
  }
  for (const r of results) {
    if (r.live.live && r.live.reason === "tmux-session-alive") {
      const tok = driverNameToken(r.s.name);
      if (tok && strongLiveNames.has(tok)) {
        r.live = { live: false, reason: "tmux-name-superseded" };
      }
    }
  }

  for (const { s, live } of results) {
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

    // DEAD — verifySessionLive false = POSITIVE-proof-of-dead (registry-miss ∧
    // record-pid-kill-0-dead/absent). Alice-safety is already inside
    // verifySessionLive: a REG-absent row whose record-pid is kill-0-ALIVE returns
    // live via the "pid-kill0" backstop and never reaches here. DEMOTE-ONLY — this
    // is the sole auto-mutation; it NEVER respawns.
    if (s.resuming) continue; // never touch a resuming row
    if (s.status !== "ended") {
      // §22 de-ghost (the missing piece): a frozen NON-ended-but-dead row — e.g.
      // the frozen-"idle" ghosts (REG-absent ∧ tmux-dead) reconciled-nowhere — is
      // DEMOTED to ended+hidden. The reap below only fired on already-ended rows,
      // so idle/active ghosts fell straight through it.
      // A tmux-name-superseded verdict is HEURISTIC (weak-axis, no strong proof-
      // of-death), so it earns a dedicated minimum grace EVEN under graceMs:0 (the
      // prod sweep) — a strong-proven-dead row does not. Real ghosts are far past
      // it; the belt only shields a recently-active row in the degenerate anomaly.
      const demoteGrace =
        live.reason === "tmux-name-superseded"
          ? Math.max(graceMs, SUPERSEDED_DEMOTE_MIN_GRACE_MS)
          : graceMs;
      if (agedOut(s, opts.nowMs, demoteGrace)) {
        actions.push({
          sessionId: s.id,
          updates: { status: "ended", endedAt: s.endedAt ?? opts.nowMs, hidden: true },
          reason: `demote:${live.reason}`,
        });
      }
    } else if (!s.hidden && agedOut(s, opts.nowMs, graceMs)) {
      // F1 reap: an already-ended, visible row → hidden (hidden-not-deleted).
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
