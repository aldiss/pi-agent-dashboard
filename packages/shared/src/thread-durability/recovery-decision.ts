/**
 * Thread-durability — the dead-holder recovery decision (design v3.6 §C3.2,
 * the round-6 F1 fold). PURE function: the §C3.2 table with the live/dead
 * asymmetry and the F1 gate (durable ENTRY ≠ durable EXECUTION).
 *
 * The live/dead asymmetry (§C3.2):
 *  - LIVE holder + any non-terminal claim → HOLD; once the indeterminate
 *    lease elapses → operator-visible BLOCK. NEVER a scan-absent retry while
 *    live (the entry may be in-memory/unflushed and still land).
 *  - EXACT-process death → the session-JSONL is FINAL/authoritative → scan:
 *      · durable EXECUTION evidence (persisted assistant child, OR an
 *        `executed` claim corroborated by persisted session evidence; a
 *        volatile TurnEnd/label ALONE is insufficient) → delivered_no_redeliver.
 *      · durable entry but NO persisted assistant child (accepted-but-
 *        unconsumed — F1), OR observed, OR queued_executing/injecting → any
 *        state WITHOUT durable execution evidence → redeliver_once (never-drop).
 *      · claim asserts executed/accepted with NO corroborating durable proof,
 *        or `evidence.conflict` set → fail_loud.
 *
 * Death is by the EXACT identity tuple (pid + session_id + start_epoch),
 * never a bare PID — a reused PID must not false-prove death (§C3.4 case 4).
 * Pure — no I/O.
 */

import type {
  Claim,
  DurableScanEvidence,
  HolderIdentity,
  HolderLiveness,
  RecoveryOutcome,
} from "./types.js";

/**
 * Resolve liveness by EXACT-identity-tuple match (design §C3.2, Alice E3).
 *
 * `observed` is the identity actually alive at the claimed PID right now, or
 * `null` if no process holds that PID. Liveness is `live` ONLY when all three
 * tuple fields match; a reused PID (same `pid`, different `session_id` or
 * `start_epoch`) resolves to `exact_death` — the original holder is gone even
 * though *a* process occupies its PID. This is the never-false-prove-death
 * predicate; a bare-PID comparison is deliberately NOT offered.
 */
export function resolveLiveness(
  claimIdentity: HolderIdentity,
  observed: HolderIdentity | null,
): HolderLiveness {
  if (observed === null) return "exact_death";
  const exactMatch =
    observed.pid === claimIdentity.pid &&
    observed.session_id === claimIdentity.session_id &&
    observed.start_epoch === claimIdentity.start_epoch;
  return exactMatch ? "live" : "exact_death";
}

/** Durable EXECUTION evidence — the F1 gate that suppresses re-delivery. */
function hasDurableExecution(evidence: DurableScanEvidence): boolean {
  // A persisted assistant child proves execution outright; an `executed`
  // claim counts ONLY when corroborated by persisted session evidence (a
  // volatile label alone is insufficient — the flag on the corroborated field
  // already encodes that corroboration).
  return evidence.hasPersistedAssistantChild || evidence.executedClaimCorroborated;
}

/**
 * The §C3.2 recovery table as a pure function (design v3.6, F1-folded).
 *
 * @param claim   the proof-tracking claim (its `state` is a conservative
 *                upper bound, corroborated by `evidence` after death).
 * @param liveness  EXACT-identity liveness (see `resolveLiveness`).
 * @param evidence  durable-scan evidence from the holder's FINAL session
 *                  (only authoritative when `liveness === "exact_death"`).
 * @param indeterminateLeaseElapsed  the live-branch progress flag: the
 *                bounded `indeterminate` lease has elapsed with no correlated
 *                progress → surface an operator-visible block.
 * @returns a `RecoveryOutcome` — `hold` (live, within lease) is distinct from
 *          the four terminal `RecoveryDecision` actions.
 */
export function decideRecovery(
  claim: Claim,
  liveness: HolderLiveness,
  evidence: DurableScanEvidence,
  indeterminateLeaseElapsed = false,
): RecoveryOutcome {
  // A correlated `failed` is proven not-injected → re-inject; no death needed
  // (§C3.2 "failed (correlated) → re-inject"). Applies regardless of liveness.
  if (claim.state === "failed") {
    return "redeliver_once";
  }

  // ── LIVE holder ────────────────────────────────────────────────────────
  // Ambiguity is resolved only by correlated proof or an operator-visible
  // block — NEVER by a scan-absent retry while live.
  if (liveness === "live") {
    // A live holder whose claim already reads `executed` is delivered.
    if (claim.state === "executed") return "delivered_no_redeliver";
    // Any other (non-terminal) claim while live: HOLD until the lease
    // elapses, then surface an operator-visible block.
    return indeterminateLeaseElapsed ? "operator_block" : "hold";
  }

  // ── EXACT-process death ────────────────────────────────────────────────
  // The dead holder's session-JSONL is FINAL/authoritative.

  // Inconsistency FIRST: a payload/attempt/entry conflict vs the ORIGINAL
  // tuple → fail loud, never silently deliver (the conflict may attach the
  // durable evidence to the wrong attempt/entry).
  if (evidence.conflict) {
    return "fail_loud";
  }

  // Durable EXECUTION evidence suppresses re-delivery (F1 gate).
  if (hasDurableExecution(evidence)) {
    return "delivered_no_redeliver";
  }

  // No durable execution evidence, but the claim ASSERTS a terminal/durable
  // state that the final session does not corroborate → fail loud.
  //  - `executed` with no persisted assistant child / corroboration.
  //  - `accepted` (durable barrier claimed) but the entry is not on disk.
  if (claim.state === "executed") {
    return "fail_loud";
  }
  if (claim.state === "accepted" && !evidence.entryDurable) {
    return "fail_loud";
  }

  // Everything else after exact-death without durable execution evidence:
  //  - accepted-but-unconsumed (durable entry, no assistant child — F1),
  //  - observed (runtime-local),
  //  - queued_executing / injecting (dispatching / intent),
  // → re-deliver exactly once (never-drop). Double-exec-safe: the dead
  // session is FINAL, so "no persisted assistant child" is definitive
  // proof-of-non-execution.
  return "redeliver_once";
}
