/**
 * Thread-durability — revision-CAS / reject-stale (design v3.6 §C1.1).
 *
 * Every row mutation runs under the per-row lock and validates its
 * expectation against the current row before writing. A mutation whose
 * `expected_revision` / `expected_attempt` / `expected_state` disagrees with
 * the current row is REJECTED (a stale writer re-reads the new revision and
 * reconciles). `delivered` is monotonic + terminal: a delivered row admits no
 * further mutation, so `delivered` can never regress.
 *
 * Pure — no I/O. The lock + atomic write live server-side (Phase B2); this is
 * the decision the writer consults inside the critical section.
 */

import type { DeliveryRecord } from "./types.js";

/** The optimistic-concurrency expectation a writer asserts (design §C1.1). */
export interface ExpectedMutation {
  expected_revision: number;
  expected_attempt: number;
  expected_state: DeliveryRecord["state"];
}

/** Reason codes for a rejected mutation — stable, machine-checkable. */
export type MutationRejectReason =
  | "delivered_terminal"
  | "revision_mismatch"
  | "attempt_mismatch"
  | "state_mismatch";

export interface MutationValidation {
  ok: boolean;
  reason?: MutationRejectReason;
}

/**
 * Validate a mutation's expectation against the current row (design §C1.1).
 *
 * Order of checks (most-terminal first):
 *  1. `delivered` is monotonic + terminal — a delivered row rejects EVERY
 *     mutation, so `delivered` never regresses and no writer commits past it.
 *  2. revision must match (reject-stale).
 *  3. attempt must match (a fact/mutation for an old attempt cannot land).
 *  4. state must match (the claimed pre-state must be the current state).
 *
 * `reconcileAccepted`'s idempotent "already delivered → noop" is handled in
 * `reconcile.ts`; that path does NOT route a write through here, so rule (1)
 * correctly treats any *mutation* of a delivered row as stale/illegal.
 */
export function validateMutation(
  expected: ExpectedMutation,
  current: DeliveryRecord,
): MutationValidation {
  if (current.delivered) {
    return { ok: false, reason: "delivered_terminal" };
  }
  if (expected.expected_revision !== current.revision) {
    return { ok: false, reason: "revision_mismatch" };
  }
  if (expected.expected_attempt !== current.attempt) {
    return { ok: false, reason: "attempt_mismatch" };
  }
  if (expected.expected_state !== current.state) {
    return { ok: false, reason: "state_mismatch" };
  }
  return { ok: true };
}
