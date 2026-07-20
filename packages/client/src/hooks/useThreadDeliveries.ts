/**
 * useThreadDeliveries — fetch hook for the read-only thread-view.
 *
 * Mirrors `useArchiveListing`: `{data, isLoading, error}` with a `cancelled`
 * guard. Degrades gracefully when the endpoint is unregistered (the held-until-
 * A4/B3 state) — `endpointAvailable:false` + empty deliveries, never a crash.
 * An injectable `fetcher` (default: the real REST call) lets stories/tests feed
 * fixture data without a live server (same pattern as `DiagnosticsSection`).
 */
import { useState, useEffect } from "react";
import {
  fetchThreadDeliveries,
  type ThreadDeliveriesResult,
  type ThreadViewDelivery,
} from "../lib/thread-view-api.js";

export interface ThreadDeliveriesState {
  deliveries: ThreadViewDelivery[];
  isLoading: boolean;
  error: string | undefined;
  /** False when the route is unregistered/404 → render the held empty-state. */
  endpointAvailable: boolean;
}

export type ThreadDeliveriesFetcher = (threadId: string) => Promise<ThreadDeliveriesResult>;

export function useThreadDeliveries(
  threadId: string,
  fetcher: ThreadDeliveriesFetcher = fetchThreadDeliveries,
): ThreadDeliveriesState {
  const [deliveries, setDeliveries] = useState<ThreadViewDelivery[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [endpointAvailable, setEndpointAvailable] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(undefined);

    fetcher(threadId)
      .then((result) => {
        if (cancelled) return;
        setDeliveries(result.deliveries);
        setEndpointAvailable(result.endpointAvailable);
        setIsLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.message ?? "Failed to fetch thread deliveries");
        setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [threadId, fetcher]);

  return { deliveries, isLoading, error, endpointAvailable };
}
