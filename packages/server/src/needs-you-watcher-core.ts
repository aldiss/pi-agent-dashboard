/**
 * "Needs you" band — the watcher's PURE CORE: `computeMustActSet`.
 *
 * This is the must-act computation, split from all I/O (spec §4a). It takes
 * INJECTED inputs (the open-set, a thread-index reader, the driver registry,
 * pane state, `now`, `ledgerHead`) and returns the curated `NeedsYouItem[]`.
 * The thin I/O layer (§4b, Stage 3) shells out to `decision-ledger`, reads the
 * registry + panes, and feeds this core; the core itself never touches a file,
 * a socket, or a clock — so it is exhaustively unit-testable.
 *
 * The pipeline (spec §4a, in order):
 *   1. TYPE-FILTER (A2 / Rule 1)      — keep only the actionable ledger types;
 *                                       exclude the ~2042 informational cruft.
 *   2. PROVABLE-SUPERSEDE (A6/Rule 2) — SAFETY-CRITICAL. Exclude a candidate
 *      + FRESHNESS-SAFE-READ            ONLY on a PROVEN resolver on its thread;
 *                                       if state can't be proven ⇒ `uncertain`
 *                                       (UNKNOWN-LOUD), NEVER a silent drop.
 *   3. WORTH-TRIGGERS (derived)       — stalled / idle / commitment-drop /
 *                                       phantom-hold / runaway from registry
 *                                       + pane state (the COVERAGE broadening).
 *   4. SOURCE → KIND MAP              — never collapse; production-gate →
 *                                       production-held, etc.
 *   5. LABEL + ACTION (§3)            — generate the legible label; assert the
 *                                       predicate; attach the owner action.
 *
 * SAFETY INVARIANTS (the whole reason this exists):
 *   - PROVABLE-SUPERSEDE ONLY. Never heuristic-guess an exclusion. Wrongly
 *     excluding a genuinely-open must-act is a DROP — worse than one extra item.
 *   - FRESHNESS-SAFE-READ. If the thread can't be read (index returns
 *     `undefined`) the item SURFACES with `uncertain=true`, never dropped.
 *   - Default toward SHOWING. No positive resolution-proof ⇒ surface.
 */

import {
  MAX_LABEL_CHARS,
  stableItemId,
  type Lane,
  type NeedsYouItem,
  type NeedsYouKind,
  type NeedsYouSource,
} from "@blackbelt-technology/pi-dashboard-shared/needs-you-band.js";
import {
  generateLegibleLabel,
  isVerbPhraseAction,
  type LabelInput,
} from "@blackbelt-technology/pi-dashboard-shared/needs-you-label.js";

// ── Injected input shapes ──────────────────────────────────────────────────

/**
 * A ledger event, normalized. `payload` is the DECODED object (the raw CLI
 * emits `payload` as a JSON-encoded STRING; the I/O layer JSON.parses it before
 * handing rows to the core). `summary`/`type`/`thread_id`/`status` are the
 * v2-envelope top-level fields.
 */
export interface LedgerEvent {
  event_id: string; // "dl-N"
  ts: string; // ISO
  type: string;
  thread_id: string;
  summary: string;
  status?: "open" | "closed" | "info";
  /** Present when this event resolves another (`--closes dl-N`). */
  closes?: string;
  source?: string;
  /** Decoded payload object (I/O layer JSON.parses the raw string). */
  payload?: Record<string, unknown>;
}

/**
 * A driver-registry row, projected onto the fields the derived detectors read.
 * The real `cell-driver-registry.json` `drivers[name]` row carries more; the
 * I/O layer projects it (+ cross-references ledger/session-stats for the
 * signal fields the raw registry lacks today — `cost_rate_per_min`,
 * `open_commitment`, `claimed_hold`).
 */
export interface DriverRow {
  name: string; // registry `real_name`
  runtime?: string; // "cc" | "pi" | ...
  cell?: string | null;
  domain?: string | null;
  /** Registry `state` (e.g. "active" | "ended" | "idle"). */
  state?: string | null;
  /** Registry `last_seen` ISO — staleness anchor for the stalled detector. */
  last_seen?: string | null;
  /** A task the driver CLAIMED to be working (for idle-mid-task detection). */
  claimed_task?: string | null;
  /** Token/cost burn rate (I/O layer computes from session-stats). */
  cost_rate_per_min?: number | null;
  /**
   * The operator-decision a runaway NAMES, if any ("kill it or let it run?").
   * Presence ⇒ the runaway-cost item surfaces on the operator band (§3).
   */
  runaway_operator_decision?: string | null;
  /** An open cross-tenure commitment not yet discharged (commitment-drop). */
  open_commitment?: {
    what: string;
    since: string;
    thread_id?: string;
    /** The operator-decision it NAMES ("reassign or drop it?") ⇒ operator band. */
    operator_decision?: string;
  } | null;
  /** A hold this driver claimed but that never fired (phantom-hold). */
  claimed_hold?: {
    what: string;
    since: string;
    thread_id?: string;
    /** The operator-decision it NAMES, if any ⇒ operator band. */
    operator_decision?: string;
  } | null;
  /**
   * PROVABLE crew-self-heal signal (§3 — the ONLY crew-lane gate). Set by the
   * I/O layer ONLY on a PROVEN self-heal (e.g. a live reaper owns the leak, a
   * self-heal event fired on-thread). Absent/false ⇒ NOT provably self-healable
   * ⇒ the item stays on the operator band (DROP-safe). NEVER a default-true.
   */
  provably_self_healable?: boolean | null;
}

/** A tmux pane row, projected onto what the idle/stalled detectors read. */
export interface PaneRow {
  cell?: string | null;
  driver?: string | null;
  /** The current foreground command ("bash"/"-zsh" ⇒ a bare/idle shell). */
  command?: string | null;
  /** Seconds since the pane last produced output (idle anchor). */
  idle_seconds?: number | null;
}

/** Injected dependencies the core cannot compute itself (I/O-free hooks). */
export interface MustActDeps {
  /**
   * Resolve a themed-name → role-language ("the postprod driver"). Injected so
   * the core stays pure; Stage 3 backs it with the role-registry +
   * cell-driver-registry, tests stub it. MUST NOT return a themed-name (that
   * would fail the legibility predicate downstream).
   */
  resolveRole(themedNameOrCell: string): string;
  /**
   * Owner-supplied EXACT action override, keyed by item id or ledger event id
   * (Rule 4 — verified with the owning driver; e.g. cds-postprod dl-6858's
   * revoke-path). Returns undefined ⇒ fall back to structured/default action.
   */
  actionOverride?(key: string): string | undefined;
  /**
   * Curated operator-language override for the LABEL's structured input,
   * keyed by ledger event id (Rule 3 — Peggy's curation). Merged OVER the raw
   * structured extraction so a jargon-laden / themed-name / over-long raw
   * `payload.decision` (e.g. dl-6858's contains "Salvatore" + is >120 chars)
   * is replaced by the operator-language `what`/`stakes`. Returns undefined ⇒
   * use the raw structured extraction (which the predicate then gates — an
   * un-curated jargon field fails LOUD to a placeholder, never ships illegible).
   */
  labelInputOverride?(eventId: string): { what?: string; stakes?: string; exposure?: string } | undefined;
  /**
   * Optional per-kind live-gate verifier (own-hand-verify claimed-live gates,
   * §4a.2). Returns `true`=proven-resolved (exclude), `false`=proven-open
   * (surface), `undefined`=could-not-prove (surface uncertain). NEVER
   * auto-probes credentials — the I/O layer supplies a safe verifier or none.
   */
  verifyLiveGate?(item: NeedsYouItem): boolean | undefined;
  /**
   * PLUGGABLE (d) provable-directive discriminator (interim, PENDING-JOAN-
   * RATIFY). Overrides the default `directiveVerdict`. Joan owns the final call
   * (may pick a/b/c/d or a combination + a final aggressiveness); this hook lets
   * her swap the discriminator cleanly without touching the pipeline. Scoped to
   * operator-decision / operator-ratify ONLY (the pipeline enforces the scope).
   */
  directiveDiscriminator?(candidate: LedgerEvent, index: (k: string) => LedgerEvent[] | undefined): DirectiveVerdict;
  /**
   * PLUGGABLE (§3) operator-action lane gate (interim, PENDING-JOAN-RATIFY on
   * final per-kind membership). Overrides the default `operatorActionGate`.
   * Routes each item to the operator band vs the crew self-heal lane (Auditor-8
   * dl-9218 asymmetric ruling). Joan owns the FINAL inherently-must-act-vs-
   * need-the-test membership; this hook swaps her ruling in cleanly.
   */
  operatorActionGate?(input: LaneGateInput): LaneDecision;
}

export interface MustActInputs {
  /**
   * The candidate source: `decision-ledger open-decisions --json` — the
   * closes-edge-HONORING projection (VERIFIED own-hand 2026-07-18). This is the
   * correct currency signal, NOT raw event `status`: append-only immutability
   * means a RESOLVED event still literally reads `status=open`, but
   * `open-decisions` already subtracts closes-edge-resolved items (e.g. dl-6858,
   * closed by dl-9167's top-level `closes`). So the closes-edge exclusion is
   * FREE here; the type-filter + provable-supersede + freshness layers below
   * handle the rest (live: 2185 raw → 84 actionable → a real handful).
   */
  openDecisions: LedgerEvent[];
  /**
   * Thread/cell index for the supersede scan. Given a `thread_id` OR `cell_id`,
   * returns ALL events on it (INCLUDING informational types — the landing
   * proof is often itself an info-type event, e.g. `w-step-status-transition`).
   * Returns `undefined` when the thread CANNOT be read ⇒ FRESHNESS-SAFE-READ
   * forces `uncertain=true` (never a silent drop).
   */
  ledgerThreadIndex(threadOrCellId: string): LedgerEvent[] | undefined;
  driverRegistry: DriverRow[];
  paneState: PaneRow[];
  now: number; // epoch ms
  ledgerHead: string; // "dl-N" pinned at compute-start
  deps: MustActDeps;
}

// ── Config: the type-filter allow-list + derived-detector thresholds ────────

/**
 * The ONLY ledger types ever surfaced (A1/A2). Everything else is institutional
 * record — excluded categorically. This alone cuts ~2168 → a handful.
 */
export const ACTIONABLE_LEDGER_TYPES: readonly string[] = Object.freeze([
  "production-gate",
  "terminal-blocked",
  "operator-decision",
  "operator-ratify",
]);

/**
 * A representative slice of the informational cruft types (A2) — NEVER
 * surfaced. Not exhaustive (the filter is an allow-list, so anything not in
 * ACTIONABLE_LEDGER_TYPES is excluded); exported so the type-filter test can
 * assert these specific ~2042-cruft types are dropped.
 */
export const INFORMATIONAL_LEDGER_TYPES: readonly string[] = Object.freeze([
  "decision-ledger-checkpoint",
  "w-step-status-transition",
  "pattern-87-antibody-fire",
  "mesh-bilateral",
  "architect-d20-verdict",
  "tenure-rotation",
  "rule-mutation",
  "cell-bootstrap",
  "handoff-initiated",
  "spawned-ingested",
  "deliverable-shipped",
  "cell-DONE",
]);

/** A claimed-active driver silent longer than this ⇒ stalled. 30 min. */
export const STALLED_SILENCE_MS = 30 * 60 * 1000;
/** A pane idle (bare shell) longer than this with a claimed task ⇒ idle-mid-task. 20 min. */
export const IDLE_MID_TASK_MS = 20 * 60 * 1000;
/** A claimed hold older than this that never fired ⇒ phantom-hold. 15 min. */
export const PHANTOM_HOLD_MS = 15 * 60 * 1000;
/** An open cross-tenure commitment older than this ⇒ commitment-drop. 24 h. */
export const COMMITMENT_DROP_MS = 24 * 60 * 60 * 1000;
/** Token burn above this rate ⇒ runaway-cost. tokens/min. */
export const RUNAWAY_RATE_PER_MIN = 20_000;

// ── 1. Type-filter (A2 / Rule 1) ────────────────────────────────────────────

/** Keep ONLY the actionable ledger types; drop all informational cruft. */
export function applyTypeFilter(events: LedgerEvent[]): LedgerEvent[] {
  return events.filter((e) => ACTIONABLE_LEDGER_TYPES.includes(e.type));
}

// ── 2. Provable-supersede + freshness-safe-read (A6 / Rule 2) ───────────────

/** The resolution verdict for a single candidate on its thread. */
export type ResolutionVerdict = "resolved" | "open" | "unknown";

const LANDING_TOKEN_RE = /\b(DONE|LANDED|INSTALLED|SHIPPED|CLOSED|RESOLVED|COMPLETE)\b/;

/** Parse the ordinal N from a `dl-N` id; NaN if malformed. */
export function ledgerOrdinal(eventId: string): number {
  const m = eventId.match(/^dl-(\d+)$/);
  return m ? Number(m[1]) : Number.NaN;
}

/**
 * Does `later` PROVABLY resolve `candidate`? Provable signals ONLY (never
 * heuristic) — verified own-hand against the live ledger 2026-07-18:
 *   (a) `later.closes === candidate.event_id`                 — explicit close
 *       edge. NOTE: `open-decisions` (the candidate source) ALREADY subtracts
 *       closes-edge-resolved items, so this is a DEFENSIVE backstop (fires only
 *       if a raw-status-open row with a closes-edge slips in).
 *   (b) a LANDING on the SAME cell, strictly LATER — the PRIMARY backstop for
 *       the no-closes-edge stale class. `to_state` (authoritative) OR `w_step`
 *       OR summary carries a DONE/LANDED/INSTALLED token. This is the
 *       dl-7878 → dl-8756 case (dl-8756.to_state = "DONE — …INSTALLED…").
 *   (c) `later.type === "production-apply"` on the same thread — resolves a
 *       `production-gate` (a general superseding-event signal).
 *   (d) `later.payload.unblocks` references the candidate's event_id — a weaker
 *       defensive signal (in practice `unblocks` names the downstream gate, not
 *       the candidate, so this rarely fires; kept for completeness).
 */
export function provablyResolves(candidate: LedgerEvent, later: LedgerEvent): boolean {
  if (later.event_id === candidate.event_id) return false;

  // (a) explicit close pointer (defensive — projection already honors it).
  if (later.closes && later.closes === candidate.event_id) return true;

  const candCell = candidateCell(candidate);
  const laterCell = candidateCell(later);
  const sameCell = candCell !== null && laterCell !== null && candCell === laterCell;
  const sameThread = candidate.thread_id.length > 0 && candidate.thread_id === later.thread_id;
  const strictlyLater = ledgerOrdinal(later.event_id) > ledgerOrdinal(candidate.event_id);

  // (b) landing token on the same cell, strictly later. `to_state` is the
  //     authoritative landing field; fall back to `w_step` / summary.
  if (sameCell && strictlyLater) {
    const toState = str(later.payload?.["to_state"]);
    const wStep = str(later.payload?.["w_step"]);
    if (LANDING_TOKEN_RE.test(toState) || LANDING_TOKEN_RE.test(wStep) || LANDING_TOKEN_RE.test(later.summary)) {
      return true;
    }
  }

  // (c) a production-apply on the same thread resolves a production-gate.
  if (candidate.type === "production-gate" && later.type === "production-apply" && (sameThread || sameCell) && strictlyLater) {
    return true;
  }

  // (d) unblocks referencing the candidate id (weak, defensive).
  const unblocks = later.payload?.["unblocks"];
  if (typeof unblocks === "string" && unblocks.includes(candidate.event_id)) return true;

  return false;
}

/** The cell identity of an event: explicit `payload.cell_id`, else `thread_id`. */
export function candidateCell(e: LedgerEvent): string | null {
  const cid = e.payload?.["cell_id"];
  if (typeof cid === "string" && cid.length > 0) return cid;
  return e.thread_id || null;
}

/**
 * Decide a candidate's resolution verdict via the injected thread index.
 *   - index `undefined` (thread unreadable) ⇒ "unknown" (FRESHNESS-SAFE-READ).
 *   - a provable resolver on the thread     ⇒ "resolved" (EXCLUDE).
 *   - otherwise                             ⇒ "open" (SURFACE; default-to-show).
 */
export function resolutionVerdict(
  candidate: LedgerEvent,
  index: (threadOrCellId: string) => LedgerEvent[] | undefined,
): ResolutionVerdict {
  const cell = candidateCell(candidate);
  const byThread = index(candidate.thread_id);
  const byCell = cell && cell !== candidate.thread_id ? index(cell) : undefined;

  // FRESHNESS-SAFE-READ: if we could not read the thread AT ALL, we cannot
  // prove the item's current state — surface it UNKNOWN-LOUD, never drop.
  if (byThread === undefined && byCell === undefined) return "unknown";

  const events = [...(byThread ?? []), ...(byCell ?? [])];
  for (const later of events) {
    if (provablyResolves(candidate, later)) return "resolved";
  }
  return "open";
}

// ── 2b. Operator-decision freshness (Rule-2 / the ~79-stale layer) ──────────
//
// 79 of the 84 actionable are stale-never-closed operator-decisions. The
// type-filter alone leaves 84 ≈ still-noisy; Rule-2 freshness is what cuts it
// to the real handful. SAFETY: staleness that CANNOT be proven ⇒ `uncertain`
// (UNKNOWN-LOUD), NEVER a silent drop.

/** An operator-decision aged past this with no engagement is a freshness candidate. 7 days. */
export const OPERATOR_DECISION_STALE_MS = 7 * 24 * 60 * 60 * 1000;

/** Freshness verdict for an aged operator-decision. */
export type FreshnessVerdict = "fresh" | "stale-exclude" | "stale-uncertain";

/** Sources that count as operator engagement on a thread (operator touched it). */
const OPERATOR_ENGAGEMENT_TYPES = new Set(["operator-decision", "operator-ratify", "production-apply", "production-gate"]);

/**
 * Rule-2 freshness for an operator-decision / operator-ratify candidate.
 *
 *   fresh           — within the age window ⇒ surface normally.
 *   stale-exclude   — PROVABLY resolved: aged past the window AND a GENUINE
 *                     resolver exists on the thread (`provablyResolves` — the
 *                     SAME bar as `resolutionVerdict`: a closes-edge, a landing
 *                     `to_state` DONE/LANDED, a production-apply, an unblocks
 *                     ref) AND no later operator-engagement. Only a genuine
 *                     resolver excludes — NEVER a weak "any-later-event"
 *                     cell-moved-on signal (that is a DROP-risk, the class Joan
 *                     rejected in dl-9264). §6 Peggy-ratified.
 *   stale-uncertain — aged past the window but resolution is NOT provable
 *                     (thread unreadable, OR no genuine resolver — a bare
 *                     crew-progress event does NOT count, OR a later operator-
 *                     engagement we cannot prove closed it) ⇒ SURFACE flagged
 *                     `uncertain`, never drop.
 *
 * Non-operator-decision types (production-gate / terminal-blocked) are NOT
 * subject to this — they need a positive landing/apply resolver (handled in
 * `resolutionVerdict`), not an age heuristic.
 */
export function operatorDecisionFreshness(
  candidate: LedgerEvent,
  now: number,
  index: (threadOrCellId: string) => LedgerEvent[] | undefined,
): FreshnessVerdict {
  const aged = ageMs(now, candidate.ts) > OPERATOR_DECISION_STALE_MS;
  if (!aged) return "fresh";

  const cell = candidateCell(candidate);
  const byThread = index(candidate.thread_id);
  const byCell = cell && cell !== candidate.thread_id ? index(cell) : undefined;

  // FRESHNESS-SAFE-READ: unreadable thread ⇒ cannot prove staleness ⇒ uncertain.
  if (byThread === undefined && byCell === undefined) return "stale-uncertain";

  const events = [...(byThread ?? []), ...(byCell ?? [])];

  let genuinelyResolved = false;
  let operatorEngagedLater = false;
  for (const e of events) {
    // PROVABLE-RESOLVER-ONLY (§6): the stale-exclude bar is the SAME genuine
    // resolver `resolutionVerdict` uses — NOT a weak any-later-event signal.
    if (provablyResolves(candidate, e)) genuinelyResolved = true;
    if (ledgerOrdinal(e.event_id) > ledgerOrdinal(candidate.event_id) && OPERATOR_ENGAGEMENT_TYPES.has(e.type)) {
      operatorEngagedLater = true;
    }
  }

  // A later operator-engagement means the operator may have acted on it but we
  // cannot PROVE this decision closed ⇒ prefer uncertain (never wrong-drop).
  if (operatorEngagedLater) return "stale-uncertain";
  // Provably resolved: aged + a GENUINE resolver on the thread + no operator
  // engagement since. Only this excludes.
  if (genuinelyResolved) return "stale-exclude";
  // Aged but no genuine resolver (dormant, or crew-progress-only) ⇒ can't prove
  // resolved ⇒ uncertain (the live-87 shape — DROP-safe, surfaced flagged).
  return "stale-uncertain";
}

// ── 2c. (d) provable-directive discriminator (interim PENDING-JOAN-RATIFY) ──
//
// The gap the stale-3-way misses: a RECENT operator-decision the operator has
// ALREADY acted on (a directive GIVEN, crew now executing — e.g. dl-9094) is
// NOT aged, so freshness won't catch it → it would FALSE-SURFACE → the
// honest-empty gate fails. (d) closes that, designed PROVABLE-DIRECTIVE-ONLY
// (sister to provable-supersede-only): hard-exclude ONLY when we can PROVE the
// item is parked-on-CREW, not on the operator.
//
// SCOPE: operator-decision + operator-ratify ONLY. production-gate +
// terminal-blocked KEEP surface-when-unsure — pending-ness is inherent to their
// type; (d) must NOT apply to them.
//
// INTERIM, PENDING-JOAN-RATIFY: Joan owns the final a/b/c/d choice + final
// aggressiveness. Built as a PLUGGABLE hook (`deps.directiveDiscriminator`) so
// her call swaps cleanly without touching the pipeline.

/**
 * (d) verdict for an operator-decision / operator-ratify candidate:
 *   - "surface"           — the payload NAMES an awaited operator action (a real
 *                           pending pick). CONFIDENT. PROTECTED: never soft-
 *                           superseded by crew-progress (governs step 5).
 *   - "exclude"           — no awaited operator-action named AND a PROVABLE
 *                           directive (a convergence / decision-given event on
 *                           the thread) ⇒ parked-on-crew, not you.
 *                           CONVERGENCE-ONLY (dl-9224): ≥2-crew-progress does
 *                           NOT exclude — it is ambiguous ⇒ surface-uncertain.
 *   - "surface-uncertain" — no action named but NOT provably a directive ⇒
 *                           SURFACE flagged `uncertain` (UNKNOWN-LOUD), never
 *                           drop (a genuine pick that just didn't name its
 *                           action still surfaces).
 */
export type DirectiveVerdict = "surface" | "exclude" | "surface-uncertain";

/**
 * Payload fields that NAME an awaited OPERATOR action (a real pending pick).
 * Presence of any ⇒ "action-named" ⇒ SURFACE + PROTECTED.
 */
function namesAwaitedOperatorAction(payload: Record<string, unknown> | undefined): boolean {
  if (!payload) return false;
  if (str(payload["awaited_operator_action"]).length > 0) return true;
  if (str(payload["operator_action"]).length > 0) return true;
  if (str(payload["pending_action"]).length > 0) return true;
  if (payload["operator_action_required"] === true) return true;
  // A genuine pick offering ≥2 options the operator must choose between.
  const options = payload["decision_options"] ?? payload["options"];
  if (Array.isArray(options) && options.length >= 2) return true;
  // An `awaiting` field that explicitly names the operator.
  if (/operator/i.test(str(payload["awaiting"]))) return true;
  return false;
}

/** A later event that CONVERGES / GIVES the directive (decision-given signal). */
const DIRECTIVE_GIVEN_RE = /\b(converg\w*|directive\w*|decid\w*|go-ahead|greenlit|approv\w*|proceed\w*)\b/i;
// NOTE (4a — LIKELY future reconcile, HELD pending explicit Joan↔Auditor-8
// convergence): a `no-action + ≥2-crew-progress + no-convergence` item is
// intended to route to a lower-tier "possibly-needs-you/unverified" lane (still
// surface-uncertain, NOT main-band, NOT dropped). Under CONVERGENCE-ONLY it
// ALREADY lands on surface-uncertain (crew-progress no longer excludes), so no
// crew-progress-type set is needed today; if the lower-tier lane needs to key
// specifically off crew-progress event types, re-introduce the set here.

/**
 * Is there on-thread/cell evidence the directive was GIVEN? PROVABLE =
 * a convergence / decision-given event strictly after the candidate.
 *
 * CONVERGENCE-ONLY (Joan + Auditor-8 converged 2026-07-18, dl-9224): a
 * `crewProgress >= 2` signal is NOT provable-directive — crew can prep BOTH
 * options of a LIVE pick while the operator's action is still awaited, so
 * excluding on it risks DROPPING a live must-act (JOINT DROP>FLOOD). Only a
 * genuine convergence/decision-given event hard-excludes; ≥2-crew-progress is
 * AMBIGUOUS and falls through to surface-uncertain (the lower-tier lane).
 */
function provablyBeingExecuted(
  candidate: LedgerEvent,
  index: (k: string) => LedgerEvent[] | undefined,
): boolean {
  const cell = candidateCell(candidate);
  const byThread = index(candidate.thread_id);
  const byCell = cell && cell !== candidate.thread_id ? index(cell) : undefined;
  if (byThread === undefined && byCell === undefined) return false; // can't read ⇒ can't prove

  const events = [...(byThread ?? []), ...(byCell ?? [])];
  const candOrd = ledgerOrdinal(candidate.event_id);
  let convergence = false;
  for (const e of events) {
    if (ledgerOrdinal(e.event_id) <= candOrd) continue; // strictly later only
    if (DIRECTIVE_GIVEN_RE.test(e.summary) || DIRECTIVE_GIVEN_RE.test(str(e.payload?.["note"]))) convergence = true;
  }
  // CONVERGENCE-ONLY: ≥2-crew-progress is NOT a provable directive (it is
  // AMBIGUOUS — could be crew prepping both arms of a still-live pick).
  return convergence;
}

/**
 * The DEFAULT (d) discriminator. Overridable via `deps.directiveDiscriminator`.
 * Caller (the pipeline) guarantees `candidate.type` is operator-decision /
 * operator-ratify before invoking this.
 */
export function directiveVerdict(
  candidate: LedgerEvent,
  index: (k: string) => LedgerEvent[] | undefined,
): DirectiveVerdict {
  // action-named ⇒ SURFACE (confident) + PROTECTED (never soft-superseded).
  if (namesAwaitedOperatorAction(candidate.payload)) return "surface";
  // no-action-named + PROVABLE directive ⇒ EXCLUDE (parked-on-crew).
  if (provablyBeingExecuted(candidate, index)) return "exclude";
  // no-action-named + NOT provably a directive ⇒ SURFACE-UNCERTAIN (never drop).
  return "surface-uncertain";
}

// ── 2d. Operator-action lane gate (§3 — Auditor-8 dl-9218 ASYMMETRIC ruling) ─
//
// Extends the (d) operator-action test from operator-decision-only to ALSO
// cover the derived worth-triggers, routing each item to the operator band vs
// the crew self-heal lane. It is the SAME provable test as (d) (sister shape,
// same DROP-safety), applied per-kind with an ASYMMETRIC default.
//
// THE INVARIANT (Auditor-8): the ONLY thing that routes to `crew-lane` is
// PROVABLY crew-self-healable (no operator-action AND provable crew-self-heal).
// Everything else → operator band. UNCERTAIN → SURFACE-UNCERTAIN on the
// operator band, NEVER silent-route-to-crew (that would be a DROP).
//
// PLUGGABLE + INTERIM: Joan owns the FINAL per-kind membership (inherently-must-
// act vs need-the-test). Swap via `deps.operatorActionGate`.

/** The per-item lane decision: the render lane + whether to flag uncertain. */
export interface LaneDecision {
  lane: Lane;
  uncertain: boolean;
}

/** The signals the gate reads for a candidate (ledger-derived or worth-derived). */
export interface LaneGateInput {
  kind: NeedsYouKind;
  origin: "ledger" | "derived";
  /** derived_state when origin=derived (stalled/idle/runaway). */
  derivedState?: "stalled" | "idle" | "runaway";
  /** Does this item NAME an awaited operator decision/action? (surface-confident) */
  namesOperatorAction: boolean;
  /** Is this PROVABLY crew-self-healable? (the ONLY crew-lane gate) */
  provablyCrewSelfHealable: boolean;
}

/**
 * Kinds that are INHERENTLY must-act — they SKIP the operator-action test and
 * always land on the operator band (Auditor-8 §3):
 *   - `parked-decision`, `production-held` (always operator-facing).
 *   - ledger `terminal-blocked` → `stalled-deliverable` with origin=ledger (a
 *     driver EXPLICITLY banked a blocker needing operator action — DISTINCT from
 *     a watcher-INFERRED derived-stalled).
 */
export function isInherentlyMustAct(g: LaneGateInput): boolean {
  if (g.kind === "parked-decision" || g.kind === "production-held") return true;
  // ledger terminal-blocked (banked blocker) is inherent; derived-stalled is not.
  if (g.kind === "stalled-deliverable" && g.origin === "ledger") return true;
  return false;
}

/**
 * The DEFAULT operator-action lane gate. Overridable via
 * `deps.operatorActionGate`. Auditor-8 ASYMMETRIC per-kind default:
 *   - inherently-must-act ⇒ operator-band (skip the test).
 *   - PROVABLY crew-self-healable ⇒ crew-lane (the ONLY crew-lane path).
 *   - names an operator action ⇒ operator-band, CONFIDENT.
 *   - else, per-kind default:
 *       · stalled / idle (derived-stalled): DEFAULT operator-facing, CONFIDENT
 *         (a stall plausibly needs an operator unblock).
 *       · phantom-hold / commitment-drop / runaway-cost: DEFAULT crew-lane, but
 *         since it is NOT provably crew-self-healable here, it surfaces
 *         UNCERTAIN on the operator band (never silent-drop).
 */
export function operatorActionGate(g: LaneGateInput): LaneDecision {
  if (isInherentlyMustAct(g)) return { lane: "operator-band", uncertain: false };

  // The ONLY crew-lane path: PROVABLY crew-self-healable (+ no operator action).
  if (g.provablyCrewSelfHealable && !g.namesOperatorAction) {
    return { lane: "crew-lane", uncertain: false };
  }

  // Names an awaited operator action ⇒ operator band, confident.
  if (g.namesOperatorAction) return { lane: "operator-band", uncertain: false };

  // Per-kind asymmetric default (not-named, not provably self-healable):
  const derivedStall = g.kind === "stalled-deliverable"; // derived here (ledger handled above)
  if (derivedStall) {
    // stalled/idle default operator-facing, CONFIDENT.
    return { lane: "operator-band", uncertain: false };
  }
  // phantom-hold / commitment-drop / runaway-cost default crew-lane, but not
  // provably self-healable ⇒ SURFACE-UNCERTAIN on the operator band (DROP-safe).
  return { lane: "operator-band", uncertain: true };
}

// ── 3. Worth-trigger detectors (derived — the COVERAGE broadening) ──────────

/** A derived candidate before label/action generation. */
interface DerivedCandidate {
  kind: NeedsYouKind;
  source: NeedsYouSource;
  input: LabelInput;
  actionKey: string;
  defaultAction: string;
  halt_tier: boolean;
  /** §3 lane-gate signal: does this derived item NAME an awaited operator action? */
  namesOperatorAction: boolean;
  /** §3 lane-gate signal: is it PROVABLY crew-self-healable? (ONLY crew-lane gate) */
  provablyCrewSelfHealable: boolean;
}

function ageMs(nowMs: number, sinceIso: string | null | undefined): number {
  if (!sinceIso) return 0;
  const t = Date.parse(sinceIso);
  return Number.isNaN(t) ? 0 : nowMs - t;
}

/**
 * Derived detectors over the registry + panes. Each is keyed on real registry
 * fields; where the raw registry lacks a signal today, the I/O layer populates
 * the projected field (and a fixture row proves the detector fires).
 */
export function detectWorthTriggers(
  registry: DriverRow[],
  panes: PaneRow[],
  now: number,
  deps: MustActDeps,
): DerivedCandidate[] {
  const out: DerivedCandidate[] = [];

  for (const d of registry) {
    const role = deps.resolveRole(d.cell ?? d.name);

    // stalled: claimed-active but silent past the threshold.
    if ((d.state === "active" || d.claimed_task) && ageMs(now, d.last_seen) > STALLED_SILENCE_MS) {
      out.push({
        kind: "stalled-deliverable",
        source: { origin: "derived", derived_state: "stalled", cell_id: d.cell ?? undefined },
        input: {
          kind: "stalled-deliverable",
          subject: role,
          what: d.claimed_task
            ? `no progress on ${d.claimed_task} for over ${Math.round(STALLED_SILENCE_MS / 60000)} min`
            : `claimed active but silent for over ${Math.round(STALLED_SILENCE_MS / 60000)} min`,
        },
        actionKey: `stalled:${d.name}`,
        defaultAction: `Check on ${role} and unblock or stop it.`,
        halt_tier: false,
        // stalled defaults operator-facing; crew-lane ONLY if provably self-heal.
        namesOperatorAction: false,
        provablyCrewSelfHealable: d.provably_self_healable === true,
      });
    }

    // runaway-cost: token burn above the rate cap.
    if (typeof d.cost_rate_per_min === "number" && d.cost_rate_per_min > RUNAWAY_RATE_PER_MIN) {
      out.push({
        kind: "runaway-cost",
        source: { origin: "derived", derived_state: "runaway", cell_id: d.cell ?? undefined },
        input: {
          kind: "runaway-cost",
          subject: role,
          // Verbless burn phrase — the template supplies "burned" (Peggy §1).
          what: `~${Math.round(d.cost_rate_per_min / 1000)}k tokens/min with no checkpoint`,
        },
        actionKey: `runaway:${d.name}`,
        defaultAction: d.runaway_operator_decision
          ? `Decide: ${d.runaway_operator_decision}`
          : `Stop ${role} and review its loop before restarting.`,
        halt_tier: false,
        // runaway defaults crew-lane UNLESS it names an operator decision.
        namesOperatorAction: typeof d.runaway_operator_decision === "string" && d.runaway_operator_decision.length > 0,
        provablyCrewSelfHealable: d.provably_self_healable === true,
      });
    }

    // commitment-drop: an open cross-tenure commitment past the window.
    if (d.open_commitment && ageMs(now, d.open_commitment.since) > COMMITMENT_DROP_MS) {
      const days = Math.round(ageMs(now, d.open_commitment.since) / (24 * 3600 * 1000));
      out.push({
        kind: "commitment-drop",
        source: {
          origin: "derived",
          derived_state: "stalled",
          cell_id: d.cell ?? undefined,
          thread_id: d.open_commitment.thread_id,
        },
        input: {
          kind: "commitment-drop",
          subject: role,
          what: d.open_commitment.what,
          ageDays: days,
        },
        actionKey: `commitment:${d.name}`,
        defaultAction: d.open_commitment.operator_decision
          ? `Decide: ${d.open_commitment.operator_decision}`
          : `Assign ${d.open_commitment.what} to a driver and confirm it lands.`,
        halt_tier: false,
        // commitment-drop defaults crew-lane UNLESS it names an operator decision.
        namesOperatorAction:
          typeof d.open_commitment.operator_decision === "string" && d.open_commitment.operator_decision.length > 0,
        provablyCrewSelfHealable: d.provably_self_healable === true,
      });
    }

    // phantom-hold: a claimed hold that never fired.
    if (d.claimed_hold && ageMs(now, d.claimed_hold.since) > PHANTOM_HOLD_MS) {
      out.push({
        kind: "phantom-hold",
        source: {
          origin: "derived",
          derived_state: "idle",
          cell_id: d.cell ?? undefined,
          thread_id: d.claimed_hold.thread_id,
        },
        input: {
          kind: "phantom-hold",
          subject: role,
          what: d.claimed_hold.what,
        },
        actionKey: `phantom:${d.name}`,
        defaultAction: d.claimed_hold.operator_decision
          ? `Decide: ${d.claimed_hold.operator_decision}`
          : `Restart the hold on ${role} and confirm it fires.`,
        halt_tier: false,
        // phantom-hold defaults crew-lane UNLESS it names an operator decision.
        namesOperatorAction:
          typeof d.claimed_hold.operator_decision === "string" && d.claimed_hold.operator_decision.length > 0,
        provablyCrewSelfHealable: d.provably_self_healable === true,
      });
    }
  }

  // idle-mid-task: a bare/idle shell where a task was claimed.
  for (const p of panes) {
    const bareShell = p.command != null && /^(-?(ba|z)?sh|bash|zsh)$/.test(p.command.trim());
    const claimedTask = registry.find((d) => d.cell && d.cell === p.cell && d.claimed_task)?.claimed_task;
    if (bareShell && claimedTask && (p.idle_seconds ?? 0) * 1000 > IDLE_MID_TASK_MS) {
      const role = deps.resolveRole(p.cell ?? p.driver ?? "the driver");
      out.push({
        kind: "stalled-deliverable",
        source: { origin: "derived", derived_state: "idle", cell_id: p.cell ?? undefined },
        input: {
          kind: "stalled-deliverable",
          subject: role,
          what: `idle at a bare shell mid-task (${claimedTask})`,
        },
        actionKey: `idle:${p.cell}`,
        defaultAction: `Check on ${role} — it stopped mid-task at an idle shell.`,
        halt_tier: false,
        // idle (derived-stalled) defaults operator-facing; crew-lane only if proven.
        namesOperatorAction: false,
        provablyCrewSelfHealable:
          registry.find((d) => d.cell && d.cell === p.cell)?.provably_self_healable === true,
      });
    }
  }

  return out;
}

// ── 4. Source → kind mapping (never collapse) ───────────────────────────────

/**
 * Map a ledger candidate's type → its surface kind (A5-FINAL):
 *   production-gate  → production-held  (HALT-tier).
 *   terminal-blocked → stalled-deliverable.
 *   operator-decision / operator-ratify → parked-decision (reversible).
 */
export function ledgerTypeToKind(type: string): { kind: NeedsYouKind; halt_tier: boolean } {
  switch (type) {
    case "production-gate":
      return { kind: "production-held", halt_tier: true };
    case "terminal-blocked":
      return { kind: "stalled-deliverable", halt_tier: false };
    case "operator-decision":
    case "operator-ratify":
      return { kind: "parked-decision", halt_tier: false };
    default:
      // Should never reach here (type-filter gates first); default reversible.
      return { kind: "parked-decision", halt_tier: false };
  }
}

// ── 5. Label + action generation, and the top-level compose ─────────────────

/** Extract a role-resolved LabelInput from a ledger candidate's structured payload. */
export function buildLedgerLabelInput(e: LedgerEvent, kind: NeedsYouKind, deps: MustActDeps): LabelInput {
  const p = e.payload ?? {};
  const role = deps.resolveRole((typeof p["cell_id"] === "string" && p["cell_id"]) || e.thread_id);

  // Per-type structured extraction (NOT the raw summary).
  let what = "";
  if (e.type === "production-gate") {
    what = str(p["decision"]) || str(p["gate_class"]) || "a production action is held on your decision";
  } else if (e.type === "terminal-blocked") {
    what = str(p["fix"]) || str(p["root_cause"]) || "blocked and needs an operator action";
  } else {
    what = str(p["decision"]) || str(p["question"]) || "a pending pick is waiting on you";
  }

  const stakes = str(p["stakes"]) || undefined;
  // §2: production-held live-instance exposure/context from the REAL payload
  // (accurate-to-instance — committed-but-private ≠ leaked-public). Only for
  // production-gate → production-held; other kinds ignore it.
  const exposure =
    kind === "production-held"
      ? str(p["exposure"]) || str(p["exposure_context"]) || undefined
      : undefined;

  // Merge Peggy's curated operator-language OVER the raw structured extraction
  // (Rule 3). A curated `what`/`stakes`/`exposure` replaces a jargon-laden /
  // themed-name / over-long raw field; absent a curation, the raw extraction is
  // used and the legibility predicate gates it (fails LOUD if illegible).
  const curated = deps.labelInputOverride?.(e.event_id);
  return {
    kind,
    subject: role,
    what: curated?.what ?? what,
    stakes: curated?.stakes ?? stakes,
    exposure: curated?.exposure ?? exposure,
  };
}

/** Resolve the exact action: owner override → structured payload field → default. */
export function resolveAction(
  key: string,
  payload: Record<string, unknown> | undefined,
  defaultAction: string,
  deps: MustActDeps,
): string {
  const override = deps.actionOverride?.(key);
  if (override && override.trim().length > 0) return override;
  const structured =
    str(payload?.["action"]) ||
    str(payload?.["remediation_operator_only"]) ||
    str(payload?.["operator_action"]);
  if (structured && isVerbPhraseAction(structured)) return structured;
  return defaultAction;
}

/**
 * The top-level pure core. Runs the full pipeline and returns the curated set.
 * Per-item label generation is wrapped: a `LabelGenerationError` on ONE item
 * becomes a loud placeholder label for THAT item (surfaced, escalated by the
 * I/O layer) — it never aborts the whole set (that would be a silent drop of
 * every other must-act).
 */
export function computeMustActSet(inputs: MustActInputs): NeedsYouItem[] {
  const { openDecisions, ledgerThreadIndex, driverRegistry, paneState, now, deps } = inputs;
  const pushedAt = new Date(now).toISOString();
  const items: NeedsYouItem[] = [];

  // 1–5. Type-filter, then the composed pipeline per item.
  for (const e of applyTypeFilter(openDecisions)) {
    const isOperatorPick = e.type === "operator-decision" || e.type === "operator-ratify";

    // 2. (d) provable-directive discriminator — operator-decision/ratify ONLY.
    //    production-gate + terminal-blocked KEEP surface-when-unsure (their
    //    pending-ness is inherent) — (d) does NOT apply to them.
    let protectedPick = false; // action-named ⇒ immune to soft-supersede + stale-exclude
    let uncertain = false;
    if (isOperatorPick) {
      const discriminate = deps.directiveDiscriminator ?? directiveVerdict;
      const dVerdict = discriminate(e, ledgerThreadIndex);
      if (dVerdict === "exclude") continue; // PROVABLE directive (parked-on-crew) ⇒ exclude.
      if (dVerdict === "surface") protectedPick = true; // action-named ⇒ confident + protected.
      if (dVerdict === "surface-uncertain") uncertain = true; // UNKNOWN-LOUD, surfaced.
    }

    // 3. Provable-supersede + freshness-safe-read (HARD proof — applies to ALL,
    //    even an action-named pick: a real closes-edge / landing resolves it).
    const verdict = resolutionVerdict(e, ledgerThreadIndex);
    if (verdict === "resolved") continue; // PROVEN resolved ⇒ exclude.
    if (verdict === "unknown") uncertain = true; // unprovable read ⇒ UNKNOWN-LOUD.

    // 4. Operator-decision freshness (the DROP-averse stale-3-way). A protected
    //    (action-named) pick is IMMUNE to stale-exclude — an awaited operator
    //    action does not resolve by aging; the pipeline surfaces it confidently.
    if (isOperatorPick && !protectedPick) {
      const freshness = operatorDecisionFreshness(e, now, ledgerThreadIndex);
      if (freshness === "stale-exclude") continue; // PROVABLY overtaken ⇒ exclude.
      if (freshness === "stale-uncertain") uncertain = true; // UNKNOWN-LOUD, surfaced.
    }

    const { kind, halt_tier } = ledgerTypeToKind(e.type);
    const source: NeedsYouSource = {
      origin: "ledger",
      ledger_type: e.type as NeedsYouSource["ledger_type"],
      event_id: e.event_id,
      thread_id: e.thread_id,
      cell_id: candidateCell(e) ?? undefined,
    };
    const input = buildLedgerLabelInput(e, kind, deps);
    const defaultAction =
      kind === "production-held"
        ? "Review the held production action and give an explicit go / no-go."
        : kind === "stalled-deliverable"
          ? "Unblock the deliverable or stop it."
          : "Make the pending decision so the work can proceed.";
    const action = resolveAction(e.event_id, e.payload, defaultAction, deps);

    // §3 lane gate. Ledger picks are inherently operator-facing (parked-decision
    // / production-held / ledger terminal-blocked all skip the crew-lane test);
    // the gate returns operator-band for them. `uncertain` from steps 2–4 wins.
    const gate = deps.operatorActionGate ?? operatorActionGate;
    const laneDecision = gate({
      kind,
      origin: "ledger",
      namesOperatorAction: isOperatorPick && protectedPick,
      provablyCrewSelfHealable: false,
    });

    items.push(
      finishItem({
        kind,
        source,
        input,
        action,
        halt_tier,
        // UNKNOWN-LOUD: an unprovable read / unprovable-stale surfaces flagged.
        uncertain: uncertain || laneDecision.uncertain,
        lane: laneDecision.lane,
        pushedAt,
        drilldown: { event_id: e.event_id, thread_id: e.thread_id, raw_summary: e.summary },
      }),
    );
  }

  // 5. Derived worth-triggers — each routed by the §3 operator-action lane gate.
  const gate = deps.operatorActionGate ?? operatorActionGate;
  for (const c of detectWorthTriggers(driverRegistry, paneState, now, deps)) {
    const action = resolveAction(c.actionKey, undefined, c.defaultAction, deps);
    const laneDecision = gate({
      kind: c.kind,
      origin: "derived",
      derivedState: c.source.derived_state,
      namesOperatorAction: c.namesOperatorAction,
      provablyCrewSelfHealable: c.provablyCrewSelfHealable,
    });
    items.push(
      finishItem({
        kind: c.kind,
        source: c.source,
        input: c.input,
        action,
        halt_tier: c.halt_tier,
        uncertain: laneDecision.uncertain,
        lane: laneDecision.lane,
        pushedAt,
        drilldown: { thread_id: c.source.thread_id },
      }),
    );
  }

  return items;
}

// ── item finalization (label generate → assert → attach) ────────────────────

interface FinishArgs {
  kind: NeedsYouKind;
  source: NeedsYouSource;
  input: LabelInput;
  action: string;
  halt_tier: boolean;
  uncertain: boolean;
  lane: Lane;
  pushedAt: string;
  drilldown: NeedsYouItem["drilldown"];
}

/** The loud placeholder shown when a single item's label generation fails. */
export const LABEL_FAILED_PLACEHOLDER = "⚠ label unavailable — open details";

function finishItem(a: FinishArgs): NeedsYouItem {
  let label: string;
  try {
    label = generateLegibleLabel(a.input);
  } catch {
    // LOUD placeholder for THIS item only (I/O layer escalates); never abort
    // the whole set — that would silently drop every other must-act.
    label = LABEL_FAILED_PLACEHOLDER;
  }
  return {
    id: stableItemId(a.source),
    kind: a.kind,
    source: a.source,
    label,
    action: a.action,
    halt_tier: a.halt_tier,
    uncertain: a.uncertain,
    lane: a.lane,
    pushed_at: a.pushedAt,
    drilldown: a.drilldown,
  };
}

// ── tiny helpers ─────────────────────────────────────────────────────────────

/** Coerce an unknown payload field to a trimmed string ("" when absent). */
function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Re-export for the I/O layer + tests (keeps the cap in one place). */
export { MAX_LABEL_CHARS };
