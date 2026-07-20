/**
 * Thread-durability bridge — the delivery-state channel (design v3.6 §C3.1 /
 * A5). The injection primitive emits proof-tracking outcomes as a stream of
 * `DeliveryStateEvent`s; the server (A5 thread-status push, Phase B4) consumes
 * them to keep the outbox view truthful. Pure types + a sink function — no
 * transport here (Phase B4 wires the WebSocket forward).
 *
 * These are dashboard/bridge/mesh-infra signals, NOT ledger event types
 * (Constraint #2 — no ledger-type touch).
 */

/**
 * A delivery-state transition/outcome emitted during injection or recovery.
 * The `kind` tracks the proof-tracking claim's observable progress.
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
 * A tiny fan-out sink hub — the bridge registers the server-forward sink here;
 * `emit` delivers to every subscriber. Isolated so a throwing subscriber never
 * breaks injection (each is try/caught).
 */
export class DeliveryStateChannel {
  private readonly sinks = new Set<DeliveryStateSink>();

  subscribe(sink: DeliveryStateSink): () => void {
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }

  /** The sink to hand `injectDelivery`/recovery — fans out to all subscribers. */
  get sink(): DeliveryStateSink {
    return (event) => {
      for (const s of this.sinks) {
        try {
          s(event);
        } catch {
          /* a subscriber must never break the injection path */
        }
      }
    };
  }

  /** Number of active subscribers (introspection/tests). */
  get size(): number {
    return this.sinks.size;
  }
}
