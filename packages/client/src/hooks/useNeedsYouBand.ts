/**
 * useNeedsYouBand — polls `GET /api/needs-you-band` (the standing watcher's
 * feed, surfaced via the Stage-4 route) and exposes the band state for the
 * `NeedsYouBand` component. Mirrors `useFleetBrief` (poll cadence, `mountedRef`
 * guard, `{success:true}`-SHAPE oracle — a 200 carrying `{success:false}` is a
 * FAILURE, never a false calm-zero).
 *
 * DELIVERY-PROOF (Rule 5): after a successful fetch that yields operator-band
 * items, the hook POSTs `/api/needs-you-band/delivery-receipt` with the
 * received item ids — proving the operator surface RECEIVED the fire, not just
 * that the watcher emitted it. Deduped by the id-set signature so a stable set
 * posts once, not every 15s poll.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { getApiBase } from "../lib/api-context.js";
import {
  CLIENT_POLL_INTERVAL_MS,
  type NeedsYouItem,
} from "@blackbelt-technology/pi-dashboard-shared/needs-you-band.js";
import { partitionBandZones, renderedReceiptIds } from "../lib/needs-you-band.js";

export interface UseNeedsYouBandResult {
  items: NeedsYouItem[];
  /** BLIND liveness — the watcher heartbeat is fresh. false ⇒ loud stale banner. */
  watcherLive: boolean;
  /** Set when `watcherLive=false` (e.g. "heartbeat stale: last beat 214s ago"). */
  staleReason: string | null;
  computedAt: string | null;
  /** `"pending"` until the first fetch settles, then `"success"` / `"failure"`. */
  outcome: "pending" | "success" | "failure";
}

export function useNeedsYouBand(): UseNeedsYouBandResult {
  const [items, setItems] = useState<NeedsYouItem[]>([]);
  const [watcherLive, setWatcherLive] = useState(false);
  const [staleReason, setStaleReason] = useState<string | null>(null);
  const [computedAt, setComputedAt] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<"pending" | "success" | "failure">("pending");
  const mountedRef = useRef(true);
  // Delivery-proof dedupe: the last id-set signature we posted a receipt for.
  const lastReceiptSig = useRef<string>("");

  useEffect(() => {
    mountedRef.current = true;
    const postReceipt = (ids: string[]) => {
      if (ids.length === 0) return;
      const sig = ids.join(",");
      if (sig === lastReceiptSig.current) return; // same set — already proven
      lastReceiptSig.current = sig;
      // Best-effort — a failed receipt just means the watcher re-escalates.
      void fetch(`${getApiBase()}/api/needs-you-band/delivery-receipt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ received_item_ids: ids, received_at: new Date().toISOString() }),
      }).catch(() => {});
    };

    const fetchBand = async () => {
      try {
        const res = await fetch(`${getApiBase()}/api/needs-you-band`);
        if (!res.ok) { if (mountedRef.current) setOutcome("failure"); return; }
        const body = await res.json();
        if (!mountedRef.current) return;
        // Shape oracle: success requires `{success:true}`, NOT merely HTTP-200.
        if (body?.success === true && body.data) {
          const data = body.data;
          const nextItems: NeedsYouItem[] = Array.isArray(data.items) ? data.items : [];
          setItems(nextItems);
          setWatcherLive(data.watcher_live === true);
          setStaleReason(typeof data.stale_reason === "string" ? data.stale_reason : null);
          setComputedAt(typeof data.computed_at === "string" ? data.computed_at : null);
          setOutcome("success");
          // DELIVERY-PROOF: post the receipt for the operator-band items rendered.
          postReceipt(renderedReceiptIds(partitionBandZones(nextItems)));
        } else {
          setOutcome("failure");
        }
      } catch {
        if (mountedRef.current) setOutcome("failure");
      }
    };
    void fetchBand();
    // Poll cadence defaults to CLIENT_POLL_INTERVAL_MS. A test-only seam lets the
    // E2E drive a faster poll (`window.__NEEDS_YOU_POLL_MS__`) so feed-change
    // specs don't wait a full 15s per step — no production behavior change (the
    // override is unset in prod).
    const overrideMs = typeof window !== "undefined" ? (window as { __NEEDS_YOU_POLL_MS__?: number }).__NEEDS_YOU_POLL_MS__ : undefined;
    const pollMs = typeof overrideMs === "number" && overrideMs > 0 ? overrideMs : CLIENT_POLL_INTERVAL_MS;
    const handle = window.setInterval(fetchBand, pollMs);
    return () => {
      mountedRef.current = false;
      window.clearInterval(handle);
    };
  }, []);

  return useMemo(
    () => ({ items, watcherLive, staleReason, computedAt, outcome }),
    [items, watcherLive, staleReason, computedAt, outcome],
  );
}
