/**
 * Cold-load HTTP fetch for /api/sessions — populates the session-list
 * immediately on app mount, BEFORE the WebSocket `sessions_snapshot`
 * arrives.
 *
 * Closes JadeIce mobile-ux-audit Cluster A n=6 root-cause cluster
 * (WebSocket-only stochastic-dependence-on-broker-mutation-event-arrival
 * left clients with empty session list for 40s+ on cold-load when no
 * session mutation fired during the wait window).
 *
 * Race coexistence with WebSocket `sessions_snapshot`:
 *   - HTTP fetch populates sessions FIRST (cold-load fast-path).
 *   - WebSocket `sessions_snapshot` arrives ~100-500ms later
 *     (after WS handshake + first server push) and REPLACES the Map
 *     atomically per useMessageHandler.ts:458-465 canonical semantics.
 *   - Both responses derive from the same server-side
 *     sessionManager.listAll() canonical-source, so REPLACE is
 *     content-consistent — no merge logic needed.
 *
 * See cell: dashboard-pwa-cold-load-fix/v1
 */
import { useEffect, useRef } from "react";
import { getApiBase } from "../lib/api-context.js";
import type {
  ApiResponse,
  DashboardSession,
} from "@blackbelt-technology/pi-dashboard-shared/types.js";

export interface UseSessionsBootstrapOptions {
  setSessions: React.Dispatch<React.SetStateAction<Map<string, DashboardSession>>>;
  /** WebSocket connection status — accepted for future-flexibility; NOT
   *  currently consulted by the hook (guard against double-population is
   *  via current.size > 0 size-check inside the setSessions callback).
   *  See cell `dashboard-pwa-cold-load-fix/v1` W8 Bert d22 Q-d22-bonus-2. */
  wsStatus: "connected" | "connecting" | "offline" | "auth_required";
  /**
   * Reports the REST `/api/sessions` cold-load outcome for the `hasLoadedOnce`
   * dual-source oracle (build-2 P0 fix #7). Called EXACTLY once per mount with
   * `"success"` (HTTP ok + a valid array body, INCLUDING `[]`) or `"failure"`
   * (non-ok / malformed / network error). A `"success"` on a valid empty array
   * is still success — loading ≠ empty. Optional (back-compat).
   */
  onRestSettled?: (outcome: "success" | "failure") => void;
}

export function useSessionsBootstrap({
  setSessions,
  wsStatus,
  onRestSettled,
}: UseSessionsBootstrapOptions): void {
  // Fire once per mount — even if WS later disconnects + reconnects, the
  // reconnect path triggers a fresh `sessions_snapshot` so we don't need
  // to re-bootstrap via HTTP.
  const firedRef = useRef(false);

  useEffect(() => {
    if (firedRef.current) return;
    firedRef.current = true;

    const abort = new AbortController();
    (async () => {
      try {
        const res = await fetch(`${getApiBase()}/api/sessions`, {
          signal: abort.signal,
        });
        if (!res.ok) { onRestSettled?.("failure"); return; } // WebSocket will populate on its own.
        const body = (await res.json()) as ApiResponse<DashboardSession[]>;
        if (!body.success || !Array.isArray(body.data)) { onRestSettled?.("failure"); return; }

        // A valid array (including `[]`) is a SUCCESS — loading ≠ empty.
        onRestSettled?.("success");
        setSessions((current) => {
          // Guard: if WebSocket sessions_snapshot already populated the
          // map (because WS handshake beat HTTP), do NOT overwrite — WS
          // is the canonical-fresher source post-snapshot.
          if (current.size > 0) return current;
          return new Map(body.data!.map((s) => [s.id, s]));
        });
      } catch (e) {
        // AbortError on unmount is not a real failure — don't report it.
        if ((e as { name?: string })?.name !== "AbortError") onRestSettled?.("failure");
        // network error on offline — WS-on-reconnect path handles recovery.
      }
    })();

    return () => abort.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // mount-only; size-guard inside setSessions handles WS-race canonical
}
