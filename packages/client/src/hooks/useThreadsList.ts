/**
 * useThreadsList — fetch hook for the read-only /threads list. Mirrors
 * `useThreadDeliveries`: `{threads, isLoading, error, endpointAvailable}` with a
 * `cancelled` guard. Degrades gracefully when the endpoint is unregistered (the
 * held-until-activation state) — `endpointAvailable:false` + empty list, never a
 * crash. An injectable `fetcher` (default: the real REST call) lets the demo +
 * tests feed fixtures with no live server.
 */
import { useState, useEffect } from "react";
import { fetchThreadsList, type ThreadSummary, type ThreadsListResult } from "../lib/tier1-threads-api.js";

export type ThreadsListFetcher = () => Promise<ThreadsListResult>;

export interface ThreadsListState {
  threads: ThreadSummary[];
  isLoading: boolean;
  error: string | undefined;
  endpointAvailable: boolean;
}

export function useThreadsList(fetcher: ThreadsListFetcher = fetchThreadsList): ThreadsListState {
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [endpointAvailable, setEndpointAvailable] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(undefined);

    fetcher()
      .then((result) => {
        if (cancelled) return;
        setThreads(result.threads);
        setEndpointAvailable(result.endpointAvailable);
        setIsLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.message ?? "Failed to fetch threads");
        setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [fetcher]);

  return { threads, isLoading, error, endpointAvailable };
}
