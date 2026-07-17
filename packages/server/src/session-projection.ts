import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";

/**
 * Decorate a session for browser projection (REST + WS) — the ONE canonical
 * helper so every surface annotates identically (no divergent ad-hoc decoration).
 * NON-PERSISTED: the manager/store never carry these; they are computed here.
 *
 *  - FIX-C2 `bridgeConnected` = the :9999 bridge-socket oracle
 *    (PiGateway.isSessionConnected), computed at projection time. ANNOTATE-ONLY:
 *    it never adds/removes a session, so it can NEVER widen a principal's
 *    visible set — the guest-visibility filter (filterServerMessageForPrincipal
 *    for WS / cellAccess.filterSessions for REST) is a separate, later gate (C7).
 *    Ordering: isSessionConnected reflects the connection map at call time, so a
 *    projection built AFTER the map is updated (register installs / close clears)
 *    carries the correctly-ordered flag.
 *
 *  - FIX-C3 endedAt-normalization: a session with `endedAt` set is projected
 *    `status: "ended"` BEFORE the client filter. endedAt is cleared on
 *    reactivation (memory-session-manager / resurrection-sweep set it undefined),
 *    so endedAt-present is an unambiguous end — a stale `idle`/`active` status
 *    never renders a cleanly-ended session active. This is the live-snapshot twin
 *    of the cold-restore normalization in session-scanner.
 */
export function projectSession(
  s: DashboardSession,
  isSessionConnected: (id: string) => boolean,
): DashboardSession {
  const status = s.endedAt != null ? "ended" : s.status;
  return { ...s, status, bridgeConnected: isSessionConnected(s.id) };
}
