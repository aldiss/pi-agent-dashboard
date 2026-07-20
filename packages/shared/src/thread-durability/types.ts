/**
 * Thread-durability — pure type contract (design v3.6 §C3.1).
 *
 * The correctness spine both architects converged on: a proof-tracking
 * delivery claim + an outbox row whose state NEVER under-states crossing
 * (→ double-exec) nor over-states durability (→ drop). This module is PURE —
 * no I/O, no `fs`, no pi runtime. It defines the data shapes; the state
 * machine, revision-CAS, reconcile, and recovery-decision logic live beside
 * it in sibling pure modules.
 *
 * Ground truth: `ledger-thread-durability-design-pass-v3.6-fold.md` §C3.1
 * (the proof-tracking claim), §C3.2 (recovery table), §C3.4 (the five-case
 * falsifiable matrix). Do not edit the spec.
 */

/**
 * The SIX delivery/claim states (design v3.6 §C3.1 — the six-state count is
 * the round-6 F1 count-note). Canonical labels preserved in the doc-comments;
 * TS-safe identifiers used as the values.
 *
 *  - `injecting`         — intent recorded; nothing dispatched.
 *  - `queued_executing`  — canonical label `queued|executing` = "may cross /
 *                          dispatching". Written+fsync'd BEFORE the Pi call
 *                          (Bert ordering); a conservative UPPER BOUND on
 *                          progress (never under-states crossing). NOT
 *                          proof-of-acceptance.
 *  - `observed`          — the bridge saw the self-identifying custom entry
 *                          (post-persist seam / in-memory) and derived
 *                          `entry_id`. Runtime-local, NOT durable; does NOT
 *                          suppress post-death re-delivery.
 *  - `accepted`          — a durable barrier is PROVEN (entry verified in the
 *                          durable session-JSONL or an independently-durable
 *                          exact-entry record). Durable ENTRY, NOT durable
 *                          EXECUTION (F1).
 *  - `executed`          — a correlated following assistant turn / TurnEnd.
 *                          Terminal (→ outbox `delivered`).
 *  - `failed`            — a correlated failure result (from the bridge's own
 *                          error boundary holding the delivery tuple). Clears
 *                          the claim → re-inject is proven-safe. Terminal.
 */
export type DeliveryState =
  | "injecting"
  | "queued_executing" // canonical: `queued|executing`
  | "observed"
  | "accepted"
  | "executed"
  | "failed";

/**
 * The EXACT process/session identity tuple (design v3.6 §C3.1, Alice E3).
 * The death predicate uses ALL THREE fields — never a bare PID, because PID
 * reuse must not false-prove death.
 */
export interface HolderIdentity {
  pid: number;
  session_id: string;
  /** Monotonic process/session start epoch (or session-file holder-liveness marker). */
  start_epoch: number;
}

/**
 * The proof-tracking execution claim (design v3.6 §C3.1). Records a
 * conservative upper bound on progress; upgraded only as DURABLE PROOF
 * accrues. Lives in the global registry/outbox under C1's per-row lock (N1).
 */
export interface Claim {
  delivery_id: string;
  attempt: number;
  thread_id: string;
  holder_session_id: string;
  /** Exact identity tuple; the death predicate consults all three fields. */
  holder_identity: HolderIdentity;
  /** Monotonic fencing token issued by the A4 holder-CAS (successor > predecessor). */
  holder_epoch: number;
  payload_hash: string;
  /** Derived once the self-identifying custom entry is observed. */
  entry_id?: string;
  state: DeliveryState;
  updated_at: number;
}

/**
 * The durable outbox row (design v3.6 §C1/§C2). `delivered` is monotonic +
 * terminal (revision-CAS rejects any mutation that regresses it). `state`
 * tracks the claim's proof-tracking progression; `delivered` is the row's
 * final barrier — `executed` is the pre-`delivered` claim-terminal.
 */
export interface DeliveryRecord {
  delivery_id: string;
  attempt: number;
  thread_id: string;
  holder_session_id: string;
  payload_hash: string;
  state: DeliveryState;
  /** Monotonic optimistic-concurrency revision (C1 reject-stale). */
  revision: number;
  /** Monotonic + terminal barrier. Once true, never regresses. */
  delivered: boolean;
  entry_id?: string;
  updated_at: number;
}

/**
 * The immutable, durably-proven acceptance fact (design v3.6 §C2.1). Fed to
 * `reconcileAccepted`, validated against the ORIGINAL tuple before it may
 * terminalize a matching nonterminal row.
 */
export interface AcceptanceFact {
  delivery_id: string;
  attempt: number;
  thread_id: string;
  holder_session_id: string;
  entry_id: string;
  payload_hash: string;
  accepted_at: number;
  /** Present iff a correlated following assistant turn proved execution. */
  executed_at?: number;
}

/**
 * The ORIGINAL causal tuple a `reconcileAccepted` fact is validated against
 * (design v3.6 §C2.1). A fact for an old attempt / different payload cannot
 * close a newer attempt.
 */
export interface OriginalTuple {
  delivery_id: string;
  attempt: number;
  holder_session_id: string;
  payload_hash: string;
}

/**
 * The durable-scan evidence read from a proven-dead holder's FINAL
 * session-JSONL (design v3.6 §C3.2). Drives the exact-death recovery branch.
 *
 *  - `entryDurable`             — the `thread_delivery` entry is on disk.
 *  - `hasPersistedAssistantChild` — a persisted assistant child/descendant of
 *                                 the entry proves EXECUTION (the F1 gate).
 *  - `executedClaimCorroborated`  — a durable `executed` claim corroborated by
 *                                 persisted session evidence (a volatile
 *                                 TurnEnd/label ALONE is insufficient).
 *  - `conflict`                 — payload/attempt/entry conflict vs the
 *                                 ORIGINAL tuple, or null when consistent.
 */
export interface DurableScanEvidence {
  entryDurable: boolean;
  hasPersistedAssistantChild: boolean;
  executedClaimCorroborated: boolean;
  conflict?: "payload" | "attempt" | "entry" | null;
}

/**
 * Holder liveness by the EXACT identity tuple (design v3.6 §C3.2). `live` =
 * the exact tuple is alive → HOLD/block; `exact_death` = the exact tuple is
 * gone/reaped (bare-PID-reuse rejected) → the session is FINAL/authoritative.
 */
export type HolderLiveness = "live" | "exact_death";

/**
 * The recovery ACTION set (design v3.6 §C3.2). The four terminal decisions:
 *
 *  - `delivered_no_redeliver` — durable EXECUTION evidence; terminalize, do
 *                               NOT re-deliver.
 *  - `redeliver_once`         — never-drop: re-deliver exactly once to the
 *                               live successor (accepted-but-unconsumed /
 *                               observed / dispatching after exact-death, or a
 *                               correlated `failed`).
 *  - `operator_block`         — surface an operator-visible block (the live
 *                               indeterminate-lease-elapsed progress rule).
 *  - `fail_loud`              — claim/evidence inconsistency; retain evidence,
 *                               never silently deliver.
 */
export type RecoveryDecision =
  | "delivered_no_redeliver"
  | "redeliver_once"
  | "operator_block"
  | "fail_loud";

/**
 * The full recovery OUTCOME. `RecoveryDecision` is the four terminal ACTIONS;
 * `hold` is the passive live-and-within-lease non-action (design v3.6 §C3.2:
 * "LIVE holder with any non-terminal claim → HOLD"). HOLD is deliberately
 * distinct from `operator_block` — a hold is a silent wait pending correlated
 * proof; a block is surfaced to the operator once the indeterminate lease
 * elapses. Neither ever re-delivers while the holder is live.
 */
export type RecoveryOutcome = RecoveryDecision | "hold";
