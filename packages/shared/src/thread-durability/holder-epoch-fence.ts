/**
 * Thread-durability — the A4 `holder_epoch` D3 fence READ-SIDE (design v3.6, the
 * A4 fold; frozen field-shape Joan-163 / Gatewright §16). PURE module: no I/O,
 * no `fs`, no pi runtime, no live-ledger read. It resolves the CURRENT holder
 * epoch for a thread from its ordered `thread-holder-changed` ledger events and
 * exposes the staleness predicate the D3 fence consumes.
 *
 * v1 semantics (ADDITIVE — does NOT change the committed death-only recovery):
 *  - `holder_epoch` is a GATE-ISSUED fencing token: non-negative integer,
 *    monotonic strictly-increasing per `thread_id`. The thread-declared holder
 *    is epoch 0; the first holder change is epoch 1; each successor holder gets
 *    `prior_max + 1`. The caller NEVER supplies it.
 *  - It is the ORDERING / STALENESS-REJECT token (a claim injected under a
 *    superseded holder is stale → hold). It does NOT abort a running turn — the
 *    v1 re-delivery gate stays EXACT-DEATH-ONLY (see `decideRecovery`); a
 *    turn-gating `fence_ack` is v0.5+.
 *
 * The gate GUARANTEES monotonicity, so a non-monotonic / duplicate / gap
 * sequence is CORRUPTION, not a normal case → this module fails loud (throws).
 * Likewise a `claimEpoch` ahead of the resolved `currentEpoch` is impossible
 * (ahead of the gate) → fail loud.
 *
 * The REAL ledger wiring is DEFERRED to activation (with the B3 resolve-holder
 * ABI + the drain loop). This module ships behind the OFF gate: a pure resolver
 * over an injectable `HolderEpochResolver` seam, stubbed with fixtures in tests.
 */

/**
 * The frozen `thread-holder-changed` ledger-event view (Joan-163 field-shape).
 * Only the fields the fence read-side consults are modelled; the full ledger
 * event is fingerprint-bound / tamper-evident, but the epoch resolution needs
 * only the thread binding, the gate-issued epoch, and the holder transition.
 *
 *  - `thread_id`            — the thread this holder change belongs to.
 *  - `payload.holder_epoch` — the GATE-ISSUED epoch (non-negative int, ≥ 1 for a
 *                             change event; 0 is the thread-declared holder and
 *                             emits NO change event).
 *  - `from_holder`          — the superseded holder (session id / holder ref).
 *  - `to_holder`            — the successor holder taking the epoch.
 *  - `actor`                — the gate/actor that issued the change.
 */
export interface ThreadHolderChangedEvent {
  thread_id: string;
  payload: { holder_epoch: number };
  from_holder: string;
  to_holder: string;
  actor: string;
}

/** The thread-declared holder epoch — the baseline before any holder change. */
export const DECLARED_HOLDER_EPOCH = 0;

/** Fail-loud prefix so a corruption throw is greppable + unambiguous. */
const FENCE = "holder-epoch-fence";

/**
 * Assert a value is a non-negative integer `holder_epoch` (contract conformance
 * where the epoch is CONSUMED — the gate issues it, the caller never supplies
 * it, so a non-int / negative value is corruption). Returns the value narrowed.
 */
function assertNonNegativeIntEpoch(epoch: number, where: string): number {
  if (typeof epoch !== "number" || !Number.isInteger(epoch) || epoch < 0) {
    throw new Error(
      `${FENCE}: ${where} must be a non-negative integer holder_epoch, got ${String(epoch)}`,
    );
  }
  return epoch;
}

/**
 * Resolve the CURRENT `holder_epoch` for ONE thread from its ORDERED
 * `thread-holder-changed` events (design v3.6, A4 fold).
 *
 * Contract:
 *  - `events` MUST be the change events for a SINGLE thread, in issue order.
 *  - No change events → the thread-declared holder → epoch 0.
 *  - Otherwise the sequence MUST be monotonic strictly-increasing and CONTIGUOUS
 *    from 1 (`1, 2, 3, …`): the gate issues `prior_max + 1` per change, so the
 *    i-th change (0-based) carries epoch `i + 1`. Any duplicate, gap,
 *    regression, non-integer/negative epoch, or mixed `thread_id` is CORRUPTION
 *    → throw (fail loud). This function never silently repairs a bad sequence.
 *
 * @returns the latest (current) `holder_epoch`, or `DECLARED_HOLDER_EPOCH` (0)
 *          when the thread has had no holder change.
 * @throws  if the sequence violates the gate's monotonicity guarantee.
 */
export function resolveCurrentEpoch(events: readonly ThreadHolderChangedEvent[]): number {
  if (events.length === 0) return DECLARED_HOLDER_EPOCH;

  const threadId = events[0].thread_id;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];

    // All change events must bind to the SAME thread — a mixed batch means the
    // caller's resolver leaked cross-thread events (corruption / caller bug).
    if (ev.thread_id !== threadId) {
      throw new Error(
        `${FENCE}: mixed thread_id in change sequence — expected ${threadId}, got ${ev.thread_id} at index ${i}`,
      );
    }

    const epoch = assertNonNegativeIntEpoch(ev.payload?.holder_epoch, `event[${i}].payload.holder_epoch`);

    // The gate issues prior_max + 1 per change, so the i-th change (0-based)
    // carries epoch i + 1. A mismatch is a duplicate, gap, or regression — all
    // impossible under the gate's monotonic guarantee → fail loud.
    const expected = i + 1;
    if (epoch !== expected) {
      throw new Error(
        `${FENCE}: non-monotonic holder_epoch for thread ${threadId} — expected ${expected} at index ${i}, got ${epoch} ` +
          `(the gate guarantees a strictly-increasing contiguous sequence from 1; a gap/duplicate/regression is corruption)`,
      );
    }
  }

  // After validation the last epoch == events.length; return the field value
  // itself (faithful to the ledger, not a derived count).
  return events[events.length - 1].payload.holder_epoch;
}

/**
 * The D3 fence STALENESS predicate (design v3.6, A4 fold). Pure.
 *
 *  - `claimEpoch < currentEpoch` → `true` — the claim was injected under a
 *    holder the gate has since superseded → STALE (v1 ordering/staleness-reject:
 *    hold, do not deliver under the old holder).
 *  - `claimEpoch === currentEpoch` → `false` — the claim's holder is current.
 *  - `claimEpoch > currentEpoch` → THROW — a claim ahead of the resolved gate
 *    epoch is impossible (the gate issues epochs; nothing can hold one it has
 *    not issued) → corruption, fail loud.
 *
 * Both operands are contract-checked as non-negative integers (the epoch is
 * gate-issued wherever it is consumed).
 */
export function isStaleEpoch(claimEpoch: number, currentEpoch: number): boolean {
  assertNonNegativeIntEpoch(claimEpoch, "claimEpoch");
  assertNonNegativeIntEpoch(currentEpoch, "currentEpoch");

  if (claimEpoch > currentEpoch) {
    throw new Error(
      `${FENCE}: claimEpoch ${claimEpoch} is ahead of currentEpoch ${currentEpoch} — ` +
        `a claim cannot hold an epoch the gate has not issued (corruption)`,
    );
  }

  return claimEpoch < currentEpoch;
}

/**
 * The injectable READ seam for the thread-holder-changed events (mirrors the
 * B2/B3 `RecoverEvidenceResolver` seam). The REAL implementation — the live
 * ledger read of the A4 `thread-holder-change` verb — is DEFERRED to activation
 * (with B3 + the drain loop); this interface lets the fence read-side be
 * exercised against FIXTURES now, behind the OFF gate.
 *
 * `holderChangedEvents(threadId)` MUST return the ORDERED change events for that
 * ONE thread (issue order), or `[]` for a thread still on its declared holder.
 */
export interface HolderEpochResolver {
  holderChangedEvents(threadId: string): readonly ThreadHolderChangedEvent[];
}

/**
 * Compose the seam + the pure resolver: read one thread's change events through
 * the injected `HolderEpochResolver`, then resolve the current epoch (fail-loud
 * on a corrupt sequence, per `resolveCurrentEpoch`). This is the single entry
 * the D3 fence calls; the real resolver is wired at activation.
 */
export function resolveCurrentEpochFor(
  resolver: HolderEpochResolver,
  threadId: string,
): number {
  return resolveCurrentEpoch(resolver.holderChangedEvents(threadId));
}
