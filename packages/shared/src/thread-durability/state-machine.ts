/**
 * Thread-durability — the claim/outbox state machine (design v3.6 §C3.1).
 *
 * Legal transitions + the monotonic-progress invariant: a claim NEVER
 * under-states crossing. The forward chain is
 *
 *     injecting → queued_executing → observed → accepted → executed
 *
 * and any non-terminal state may fail: `<non-terminal> → failed`.
 *
 * Forward SKIPS are legal (never a regression): on a fresh session the
 * executing turn's first-assistant flush proves the entry durable AND
 * executes it in one step, so `observed → executed` is reachable without a
 * distinct `accepted` write (spec §C3.1 step 6; fold-ledger E1 "straight to
 * executed"). The invariant we enforce is monotonic PROGRESS, not
 * single-step adjacency.
 *
 * Terminal states: `executed` (claim-terminal → outbox `delivered`) and
 * `failed`. Pure — no I/O.
 */

import type { DeliveryState } from "./types.js";

/**
 * Progress rank along the forward chain. Higher = more progress. `failed` is
 * off-chain (it is reachable from any non-terminal state and is terminal), so
 * it has no chain rank — `canTransition` handles it explicitly.
 */
const PROGRESS_RANK: Record<Exclude<DeliveryState, "failed">, number> = {
  injecting: 0,
  queued_executing: 1,
  observed: 2,
  accepted: 3,
  executed: 4,
};

const TERMINAL: ReadonlySet<DeliveryState> = new Set<DeliveryState>([
  "executed",
  "failed",
]);

/** True iff `state` is terminal (`executed` or `failed`) — no exit transitions. */
export function isTerminal(state: DeliveryState): boolean {
  return TERMINAL.has(state);
}

/**
 * The monotonic forward-chain rank of a non-`failed` state. Exposed so
 * callers (recovery, reconcile) can assert "never under-states progress"
 * without re-deriving the ordering.
 */
export function progressRank(state: Exclude<DeliveryState, "failed">): number {
  return PROGRESS_RANK[state];
}

/**
 * Legal-transition predicate (design v3.6 §C3.1). Returns true iff moving the
 * claim/row `from → to` never under-states progress:
 *
 *  - no exit from a terminal state (`executed` / `failed`);
 *  - any non-terminal → `failed` is legal (correlated failure clears a claim);
 *  - otherwise a STRICTLY-forward move along the chain (skips allowed);
 *  - a same-rank self-loop is NOT a transition (no progress) → false;
 *  - a backward move (would under-state progress) → false.
 */
export function canTransition(from: DeliveryState, to: DeliveryState): boolean {
  // No exit from a terminal state.
  if (isTerminal(from)) return false;

  // Any non-terminal → failed (correlated failure).
  if (to === "failed") return true;

  // `from` is non-terminal and `to` is on the forward chain here (to≠failed).
  const fromRank = PROGRESS_RANK[from as Exclude<DeliveryState, "failed">];
  const toRank = PROGRESS_RANK[to as Exclude<DeliveryState, "failed">];

  // Strictly forward only — never a regression, never a same-rank self-loop.
  return toRank > fromRank;
}
