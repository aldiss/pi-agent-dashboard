/**
 * Thread-durability — the delivery-state channel contract (design v3.6 A5).
 *
 * Lifted into the shared package (B4) so BOTH the bridge (emits
 * `DeliveryStateEvent`s during injection/recovery) AND the server A5 push
 * channel (publishes `ThreadDeliverySnapshot`s from the durable outbox) share
 * one nominal contract. Pure types — no I/O, no transport.
 *
 * These are dashboard/bridge/mesh-infra signals, NOT ledger event types
 * (Constraint #2 — no ledger-type touch).
 */

import type { DeliveryState, OutboxEntry } from "./outbox-types.js";

/**
 * A delivery-state transition/outcome emitted during injection or recovery.
 * The `kind` tracks the proof-tracking claim's observable progress. These are
 * the bridge-side TRIGGERS; the server derives the canonical
 * `ThreadDeliverySnapshot` from the durable outbox (the source of truth).
 */
export type DeliveryStateEvent =
  | { kind: "dispatching"; delivery_id: string; attempt: number }
  | { kind: "queue_rejected"; delivery_id: string; reason: string }
  | { kind: "observed"; delivery_id: string; entry_id: string }
  | { kind: "accepted"; delivery_id: string; entry_id?: string }
  | { kind: "executed"; delivery_id: string; entry_id?: string }
  | { kind: "injection_failed"; delivery_id: string; error: string }
  | { kind: "fail_loud"; delivery_id: string }
  | { kind: "indeterminate"; delivery_id: string; elapsedMs: number; at: number };

/** A sink the injection/recovery calls to publish a delivery-state event. */
export type DeliveryStateSink = (event: DeliveryStateEvent) => void;

/**
 * The canonical, outbox-derived delivery snapshot the A5 channel publishes and
 * the thread-view REST returns. Every field comes from the durable
 * `OutboxEntry` — the outbox is the source of truth, never the volatile bridge
 * event. `{delivery_id, state, revision}` is the idempotency key: a
 * re-published snapshot with the same triple is a duplicate.
 */
export interface ThreadDeliverySnapshot {
  delivery_id: string;
  thread_id: string;
  attempt: number;
  state: DeliveryState;
  /** Monotonic revision — the dedup discriminator with delivery_id + state. */
  revision: number;
  delivered: boolean;
  entry_id?: string;
  updated_at: number;
}

/** Project a durable outbox row into its publishable snapshot. */
export function toThreadDeliverySnapshot(entry: OutboxEntry): ThreadDeliverySnapshot {
  return {
    delivery_id: entry.delivery_id,
    thread_id: entry.thread_id,
    attempt: entry.attempt,
    state: entry.state,
    revision: entry.revision,
    delivered: entry.delivered,
    entry_id: entry.entry_id,
    updated_at: entry.updated_at,
  };
}

/** The idempotency key for a snapshot: same triple ⇒ duplicate publish. */
export function snapshotDedupKey(s: Pick<ThreadDeliverySnapshot, "delivery_id" | "state" | "revision">): string {
  return `${s.delivery_id}::${s.state}::${s.revision}`;
}
