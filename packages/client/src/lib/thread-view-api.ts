/**
 * Thread-view client API — the read-only thread delivery-state contract.
 *
 * Talks to `packages/server/src/routes/thread-view-routes.ts`
 * (`GET /api/threads/:threadId/deliveries`). The durable outbox is the source
 * of truth; this is a READ-ONLY view (no mutation, routes no prompts).
 *
 * Contract nuance the UI must honor (design v3.6): the server
 * `ThreadDeliverySnapshot.state` is the SIX `DeliveryState`s; `delivered` is a
 * separate boolean barrier; and `indeterminate` is a LIVE delivery-state-channel
 * overlay (a bounded-lease outcome), NOT a persisted row state. So the UI
 * derives an eight-value `DisplayState` from `{state, delivered, lease?}`.
 */
import { getApiBase } from "./api-context.js";
import type {
  DeliveryState,
  ThreadDeliverySnapshot,
} from "@blackbelt-technology/pi-dashboard-shared/thread-durability/index.js";

export type { DeliveryState, ThreadDeliverySnapshot };

/**
 * The row view-model the UI renders. Extends the REST snapshot with an OPTIONAL
 * live `lease` overlay: when the injection's bounded `indeterminate` lease has
 * elapsed with no correlated progress, the delivery-state channel surfaces it
 * here — the outbox row keeps its `state` (e.g. `queued_executing`), and the UI
 * renders `indeterminate` on top (surfaced, never dropped). REST snapshots
 * carry no `lease`; the live A5 channel (future wiring) sets it.
 */
export interface ThreadViewDelivery extends ThreadDeliverySnapshot {
  lease?: "indeterminate";
}

/**
 * The eight display states the UI renders. Seven derive from a REST snapshot
 * (`delivered` promotes `executed → delivered`); `indeterminate` is the live
 * lease overlay.
 */
export type DisplayState =
  | "injecting"
  | "queued_executing"
  | "observed"
  | "accepted"
  | "executed"
  | "delivered"
  | "failed"
  | "indeterminate";

/**
 * The monotonic proof-tracking RAIL order (design v3.6 §C3.1). Off-rail
 * terminals (`failed`, `indeterminate`) are NOT on the rail — they render as
 * distinct off-rail markers.
 */
export const RAIL_ORDER: readonly DisplayState[] = [
  "injecting",
  "queued_executing",
  "observed",
  "accepted",
  "executed",
  "delivered",
] as const;

/** Human labels — the canonical `queued|executing` label is preserved. */
export const DISPLAY_LABEL: Record<DisplayState, string> = {
  injecting: "injecting",
  queued_executing: "queued | executing",
  observed: "observed",
  accepted: "accepted",
  executed: "executed",
  delivered: "delivered",
  failed: "failed",
  indeterminate: "indeterminate",
};

/** Short per-state meaning, for the row's proof caption. */
export const DISPLAY_MEANING: Record<DisplayState, string> = {
  injecting: "intent recorded — nothing dispatched yet",
  queued_executing: "may cross / dispatching — a conservative upper bound, not proof",
  observed: "seam saw the entry — runtime-local, not yet durable",
  accepted: "durable barrier proven — entry on disk (not yet executed)",
  executed: "correlated assistant turn — execution proven",
  delivered: "terminalized — exactly-once, durable and complete",
  failed: "correlated failure — claim cleared, re-inject is proven-safe",
  indeterminate: "bounded lease elapsed — surfaced for the operator, never dropped",
};

/** Derive the display state from a snapshot (+ optional live lease overlay). */
export function deriveDisplayState(d: ThreadViewDelivery): DisplayState {
  if (d.lease === "indeterminate") return "indeterminate";
  if (d.state === "failed") return "failed";
  if (d.delivered) return "delivered";
  return d.state;
}

/** True iff the display state is a terminal (no further progress expected). */
export function isTerminalDisplay(s: DisplayState): boolean {
  return s === "delivered" || s === "failed";
}

/** True iff off-rail (rendered as a distinct marker, not a rail segment). */
export function isOffRail(s: DisplayState): boolean {
  return s === "failed" || s === "indeterminate";
}

/** The result of a thread-view fetch — distinguishes "unregistered" from error. */
export interface ThreadDeliveriesResult {
  deliveries: ThreadViewDelivery[];
  /** False when the endpoint is unregistered/404 (held-activation) → clean empty-state. */
  endpointAvailable: boolean;
}

/**
 * Fetch the per-thread deliveries. Degrades GRACEFULLY: an unregistered route
 * (the held-until-A4/B3 state — `server.ts` not wired) returns 404, which we
 * surface as `endpointAvailable:false` + empty deliveries (a clean empty-state,
 * never a crash). A malformed/no-`success` body also degrades to empty.
 */
export async function fetchThreadDeliveries(threadId: string): Promise<ThreadDeliveriesResult> {
  const res = await fetch(`${getApiBase()}/api/threads/${encodeURIComponent(threadId)}/deliveries`);
  if (res.status === 404) {
    // Route not registered (held activation) — degrade to a clean empty-state.
    return { deliveries: [], endpointAvailable: false };
  }
  if (!res.ok) {
    throw new Error(`thread-view request failed (${res.status})`);
  }
  const body = await res.json();
  if (!body?.success) {
    // Non-envelope / error body — degrade rather than crash.
    return { deliveries: [], endpointAvailable: false };
  }
  const deliveries: ThreadViewDelivery[] = body.data?.deliveries ?? [];
  return { deliveries, endpointAvailable: true };
}
