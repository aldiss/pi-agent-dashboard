/**
 * useFleetBrief — assembles the fleet-brief for the depth-0 banner (build-2
 * P0 fix #5 + #6 + #9 + #12).
 *
 * Reads the whole session map + the operator surfaces (`GET
 * /api/operator-active-surfaces`, the same source `ActiveOperatorSurfaces`
 * polls) and produces:
 *   - `items`   — the ranked needs-you + non-`none` surface obligations.
 *   - `finishedUnseen` — recently-finished sessions inside the freshness
 *     window (bounded cutoff + row cap; first-run-safe baseline).
 *   - `acknowledge()` — persists "seen now"; the CALLER gates this on ACTUAL
 *     visibility (never on mount — MobileShell keeps the depth-0 panel mounted
 *     but aria-hidden at depth ≥ 1).
 *
 * See change: build-2-dashboard-v3.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import { getApiBase } from "../lib/api-context.js";
import {
  computeFleetBrief,
  finishedUnseenCutoff,
  selectFinishedUnseen,
  type FleetBriefItem,
  type FleetBriefSurface,
} from "../lib/fleet-brief.js";
import { getLastBriefViewAt, setLastBriefViewAt } from "../lib/session-filter-storage.js";

const SURFACES_POLL_MS = 15_000;

export interface UseFleetBriefResult {
  /** Ranked needs-you + surface obligations. */
  items: FleetBriefItem[];
  /** Recently-finished sessions in the freshness window. */
  finishedUnseen: DashboardSession[];
  /** Total unseen count = items + finishedUnseen (badge). */
  unseenCount: number;
  /** Persist "operator saw the brief now". Caller gates on real visibility. */
  acknowledge: () => void;
  /**
   * Surfaces-fetch outcome for the `hasLoadedOnce` oracle (build-2 P0 fix #7):
   * `"pending"` until the first fetch settles, then `"success"` / `"failure"`.
   */
  surfacesOutcome: "pending" | "success" | "failure";
}

export function useFleetBrief(
  sessions: readonly DashboardSession[],
  now: number,
): UseFleetBriefResult {
  const [surfaces, setSurfaces] = useState<FleetBriefSurface[]>([]);
  const [surfacesOutcome, setSurfacesOutcome] = useState<"pending" | "success" | "failure">("pending");
  // Re-read the persisted last-view on each acknowledge so the window advances.
  const [lastView, setLastView] = useState<number | null>(() => getLastBriefViewAt());
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const fetchSurfaces = async () => {
      try {
        const res = await fetch(`${getApiBase()}/api/operator-active-surfaces`);
        if (!res.ok) { if (mountedRef.current) setSurfacesOutcome("failure"); return; }
        const body = await res.json();
        if (!mountedRef.current) return;
        // Cold-load oracle (build-2 fix-cycle MAJOR 1): success requires the
        // `{success:true}` SHAPE, NOT merely HTTP-200. A 200 carrying
        // `{success:false, error:...}` is a FAILURE — treating it as success
        // would authorize a false calm-zero. A well-formed `{success:true}`
        // with an empty/absent surfaces array is still success (healthy empty).
        if (body?.success === true) {
          const surfaces = Array.isArray(body.data?.surfaces) ? body.data.surfaces : [];
          setSurfaces(surfaces as FleetBriefSurface[]);
          setSurfacesOutcome("success");
        } else {
          setSurfacesOutcome("failure");
        }
      } catch {
        // best-effort — brief degrades to sessions-only on fetch failure
        if (mountedRef.current) setSurfacesOutcome("failure");
      }
    };
    void fetchSurfaces();
    const handle = window.setInterval(fetchSurfaces, SURFACES_POLL_MS);
    return () => {
      mountedRef.current = false;
      window.clearInterval(handle);
    };
  }, []);

  const items = useMemo(() => computeFleetBrief(sessions, surfaces), [sessions, surfaces]);

  const finishedUnseen = useMemo(() => {
    const cutoff = finishedUnseenCutoff(lastView, now);
    return selectFinishedUnseen(sessions, cutoff, now);
  }, [sessions, lastView, now]);

  const acknowledge = useCallback(() => {
    const ts = Date.now();
    setLastBriefViewAt(ts);
    setLastView(ts);
  }, []);

  return {
    items,
    finishedUnseen,
    unseenCount: items.length + finishedUnseen.length,
    acknowledge,
    surfacesOutcome,
  };
}
