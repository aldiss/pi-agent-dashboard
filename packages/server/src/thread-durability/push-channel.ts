/**
 * Thread-durability — the A5 thread-status push channel (design v3.6 A5; B4
 * step 3). The DURABLE OUTBOX is the source of truth: every published snapshot
 * is read from the outbox row, never from a volatile bridge event.
 *
 * Reuses the fanout SHAPE of `packages/server/src/push/push-dispatcher.ts`
 * (per-subscriber isolation; a throwing subscriber never breaks the fanout;
 * publish never throws) WITHOUT duplicating the device-push transport/token
 * machinery — this is an in-server pub/sub of delivery-state deltas to browser
 * subscribers (the WebSocket forward + REST fallback wire on top of it).
 *
 * Guarantees:
 *  - **Idempotent publish** — a re-published snapshot with the same
 *    `{delivery_id, state, revision}` triple is DEDUPLICATED (monotonic
 *    per-delivery revision gate). A stale/duplicate delta never re-fans-out.
 *  - **Subscribe + replay** — a new subscriber immediately receives the
 *    current outbox snapshot for its thread(s), then live deltas.
 *  - **REST fallback** — `snapshotForThread` returns the current per-thread
 *    delivery-state snapshot for a GET endpoint when push is unavailable.
 */

import {
  toThreadDeliverySnapshot,
  snapshotDedupKey,
  type ThreadDeliverySnapshot,
} from "@blackbelt-technology/pi-dashboard-shared/thread-durability/index.js";

import type { OutboxStore } from "./outbox-store.js";

/** A subscriber callback — receives replayed + live delivery snapshots. */
export type ThreadDeliverySubscriber = (snapshot: ThreadDeliverySnapshot) => void;

export interface ThreadPushChannelOptions {
  store: OutboxStore;
}

interface Subscription {
  /** If set, only snapshots for this thread_id are delivered. */
  threadId?: string;
  cb: ThreadDeliverySubscriber;
}

/**
 * In-server delivery-state pub/sub over the durable outbox. Wire the WebSocket
 * forward as a subscriber; expose `snapshotForThread` from a GET route.
 */
export class ThreadPushChannel {
  private readonly store: OutboxStore;
  private readonly subs = new Set<Subscription>();
  /** delivery_id → highest published revision (the idempotency gate). */
  private readonly lastRevision = new Map<string, number>();

  constructor(opts: ThreadPushChannelOptions) {
    this.store = opts.store;
  }

  /**
   * Publish the current durable state of a delivery. Reads the outbox row (SoT)
   * and fans out its snapshot — but ONLY if the `{delivery_id, state, revision}`
   * triple is new (monotonic revision gate). Never throws.
   *
   * @returns the published snapshot, or null if deduplicated / row absent.
   */
  publish(deliveryId: string): ThreadDeliverySnapshot | null {
    let snapshot: ThreadDeliverySnapshot | null = null;
    try {
      const row = this.store.read(deliveryId);
      if (row === null) return null;
      snapshot = toThreadDeliverySnapshot(row);

      // Idempotency: monotonic per-delivery revision. A re-publish of the same
      // (or an older) revision is a duplicate → no fan-out.
      const seen = this.lastRevision.get(deliveryId);
      if (seen !== undefined && snapshot.revision <= seen) {
        return null;
      }
      this.lastRevision.set(deliveryId, snapshot.revision);
    } catch {
      return null; // publish must never throw
    }

    this.fanout(snapshot);
    return snapshot;
  }

  /** Fan a snapshot to every matching subscriber (per-subscriber isolation). */
  private fanout(snapshot: ThreadDeliverySnapshot): void {
    for (const sub of this.subs) {
      if (sub.threadId !== undefined && sub.threadId !== snapshot.thread_id) continue;
      try {
        sub.cb(snapshot);
      } catch {
        /* a subscriber must never break the fanout (mirrors push-dispatcher) */
      }
    }
  }

  /**
   * Subscribe to live delivery snapshots (optionally filtered to one thread).
   * On subscribe the current outbox snapshot for the thread(s) is REPLAYED
   * immediately (newest revision per delivery), then live deltas follow.
   * Returns an unsubscribe function.
   *
   * Replay is a PER-SUBSCRIBER catch-up read from the outbox (SoT), independent
   * of the publish dedup gate — it does NOT seed `lastRevision` (that would let
   * one late subscriber's replay suppress a genuine first publish to earlier
   * subscribers). In the real drain flow a row's mutate→`publish` is
   * synchronous, so a subscriber only ever replays the CURRENT revision and the
   * next `publish` it sees is a strictly-newer delta — no replay/publish
   * double-send in practice.
   */
  subscribe(cb: ThreadDeliverySubscriber, opts: { threadId?: string } = {}): () => void {
    const sub: Subscription = { threadId: opts.threadId, cb };
    this.subs.add(sub);
    // Replay current state (SoT) so a fresh subscriber is never behind.
    try {
      const rows = opts.threadId ? this.store.listByThread(opts.threadId) : this.store.list();
      for (const row of rows) {
        try {
          cb(toThreadDeliverySnapshot(row));
        } catch {
          /* replay to a throwing subscriber must not abort the loop */
        }
      }
    } catch {
      /* listing failure (empty/uncreated outbox) — no replay, still subscribed */
    }
    return () => this.subs.delete(sub);
  }

  /**
   * REST-fallback snapshot: the current delivery-state of every row for a
   * thread, sorted by `updated_at` then `delivery_id` (stable). Reads the
   * outbox directly (SoT) — works even with zero push subscribers.
   */
  snapshotForThread(threadId: string): ThreadDeliverySnapshot[] {
    return this.store
      .listByThread(threadId)
      .map(toThreadDeliverySnapshot)
      .sort((a, b) => a.updated_at - b.updated_at || a.delivery_id.localeCompare(b.delivery_id));
  }

  /** Active subscriber count (introspection/tests). */
  get subscriberCount(): number {
    return this.subs.size;
  }
}
