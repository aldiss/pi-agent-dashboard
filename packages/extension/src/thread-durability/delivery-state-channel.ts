/**
 * Thread-durability bridge — the delivery-state channel fan-out hub (design
 * v3.6 §C3.1 / A5). The `DeliveryStateEvent` + `DeliveryStateSink` CONTRACT
 * now lives in the shared package (B4 step 3, so the server A5 channel shares
 * it nominally); this module re-exports them and keeps the bridge-local
 * `DeliveryStateChannel` fan-out hub. Pure — no transport here.
 *
 * These are dashboard/bridge/mesh-infra signals, NOT ledger event types
 * (Constraint #2 — no ledger-type touch).
 */

import type {
  DeliveryStateEvent,
  DeliveryStateSink,
} from "@blackbelt-technology/pi-dashboard-shared/thread-durability/index.js";

export type {
  DeliveryStateEvent,
  DeliveryStateSink,
} from "@blackbelt-technology/pi-dashboard-shared/thread-durability/index.js";

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
    return (event: DeliveryStateEvent) => {
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
