/**
 * Thread-durability — `reconcileAccepted` (design v3.6 §C2.1/§C2.2).
 *
 * Given an IMMUTABLE, durably-proven acceptance fact, validate it against the
 * ORIGINAL causal tuple and, if valid, terminalize the matching NONTERMINAL
 * outbox row to `delivered` at `revision+1`. Binding is by `delivery_id`
 * (never text/position — §C3.4 case 5); a fact for an old attempt / different
 * payload cannot close a newer attempt; conflicting evidence fails loud and
 * retains. Pure — no I/O; runs inside the per-row lock server-side (Phase B2).
 */

import type { AcceptanceFact, DeliveryRecord, OriginalTuple } from "./types.js";

export type ReconcileAction = "terminalize" | "fail_loud" | "noop";

export interface ReconcileResult {
  action: ReconcileAction;
  /** Set only when `action === "terminalize"` — `currentRow.revision + 1`. */
  newRevision?: number;
}

/** Internal consistency: the durable fact must agree with the original tuple. */
function factMatchesOriginal(fact: AcceptanceFact, original: OriginalTuple): boolean {
  return (
    fact.delivery_id === original.delivery_id &&
    fact.attempt === original.attempt &&
    fact.holder_session_id === original.holder_session_id &&
    fact.payload_hash === original.payload_hash
  );
}

/**
 * Reconcile a durable acceptance fact against the current outbox row
 * (design v3.6 §C2.1). Decision order:
 *
 *  1. Fact vs ORIGINAL tuple mismatch → `fail_loud` (the durable fact
 *     contradicts what was sent; retain all evidence).
 *  2. `currentRow.delivery_id !== fact.delivery_id` → `noop` (bind by
 *     `delivery_id`; never close a different delivery — §C3.4 case 5).
 *  3. `currentRow.delivered` → `noop` (monotonic terminal; idempotent).
 *  4. `currentRow.attempt !== fact.attempt` → `noop` (a fact for one attempt
 *     cannot close a different/newer attempt — §C2.2).
 *  5. `currentRow.payload_hash !== fact.payload_hash` (same delivery+attempt,
 *     divergent payload) → `fail_loud` (corruption; retain).
 *  6. `currentRow.state === "failed"` (same delivery+attempt, but durable
 *     proof of acceptance contradicts a failed row) → `fail_loud`.
 *  7. otherwise (matching nonterminal row) → `terminalize` at
 *     `currentRow.revision + 1`.
 */
export function reconcileAccepted(
  fact: AcceptanceFact,
  original: OriginalTuple,
  currentRow: DeliveryRecord,
): ReconcileResult {
  if (!factMatchesOriginal(fact, original)) {
    return { action: "fail_loud" };
  }
  if (currentRow.delivery_id !== fact.delivery_id) {
    return { action: "noop" };
  }
  if (currentRow.delivered) {
    return { action: "noop" };
  }
  if (currentRow.attempt !== fact.attempt) {
    return { action: "noop" };
  }
  if (currentRow.payload_hash !== fact.payload_hash) {
    return { action: "fail_loud" };
  }
  if (currentRow.state === "failed") {
    return { action: "fail_loud" };
  }
  return { action: "terminalize", newRevision: currentRow.revision + 1 };
}
