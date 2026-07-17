/**
 * hasLoadedOnce — the dual-source cold-load success oracle (build-2 P0 fix #7).
 *
 * ONE derived boolean, NO FSM. The sidebar/landing empty-state must NEVER show
 * a calm "no sessions" until we KNOW the fleet is genuinely empty. "Know"
 * requires BOTH:
 *   1. the session source settled successfully — a successful REST
 *      `/api/sessions` response (INCLUDING a valid `[]`) OR a WebSocket
 *      `sessions_snapshot` was received; AND
 *   2. the surfaces source settled successfully — a successful
 *      `/api/operator-active-surfaces` fetch.
 *
 * A failure of EITHER source → `hasLoadedOnce` stays false → the UI shows a
 * failure / last-known state, never calm-zero. A WS-degraded-but-REST-success
 * state still settles (the REST arm satisfies source 1; surfaces is its own
 * HTTP fetch independent of the WS).
 *
 * Pure — the caller feeds the three settled signals.
 * See change: build-2-dashboard-v3.
 */

/** Outcome of a single async source: not-yet-settled, settled-ok, settled-failed. */
export type SourceOutcome = "pending" | "success" | "failure";

export interface LoadedOnceInputs {
  /** REST `/api/sessions` outcome (a valid `[]` counts as success). */
  restSessions: SourceOutcome;
  /** True once a WebSocket `sessions_snapshot` has ever been received. */
  snapshotReceived: boolean;
  /** `/api/operator-active-surfaces` fetch outcome. */
  surfaces: SourceOutcome;
}

/**
 * Derive the single `hasLoadedOnce` boolean.
 *
 * Source 1 (sessions) is satisfied by REST success OR snapshot — either proves
 * we have an authoritative session list. Source 2 (surfaces) must have
 * succeeded on its own. Both required.
 */
export function deriveHasLoadedOnce(inputs: LoadedOnceInputs): boolean {
  const sessionsOk = inputs.restSessions === "success" || inputs.snapshotReceived;
  const surfacesOk = inputs.surfaces === "success";
  return sessionsOk && surfacesOk;
}
