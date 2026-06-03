/**
 * DashboardPage — dedicated `/dashboard` route page.
 *
 * Hosts the operator-facing surfaces tile (`<ActiveOperatorSurfaces />`)
 * on its own page, split out of the session-list sidebar per operator
 * ratification 2026-05-26 ~00:40 CEST (defaults 1a + 2a + 3a):
 *   - 1a: sessions list page stays the default landing
 *   - 2a: dashboard reachable via top-bar nav link
 *   - 3a: v1 dashboard hosts Active Surfaces ONLY; future widgets
 *         (operator-focus toggle, operator-pacing toggle, etc.) bank
 *         as Section E candidates.
 *
 * Cell context:
 *   - Sister-trail with thinking-block streaming fixes
 *     (22978a8 / 36468c7 / 2283c20 / 7486fba on
 *     `fix/thinking-block-streaming-state-loss-2026-05-25`).
 *   - Sister-coordination with worker 26a4ef73 (`operator_action`
 *     field rendering inside `<ActiveOperatorSurfaces />`): tile-
 *     INTERNALS are theirs; tile-PLACEMENT (this page) is ours.
 */
import React from "react";
import { ActiveOperatorSurfaces } from "./ActiveOperatorSurfaces.js";

export function DashboardPage(): React.ReactElement {
  return (
    <div
      className="flex-1 flex flex-col min-w-0 min-h-0 overflow-y-auto bg-[var(--bg-primary)] text-[var(--text-primary)]"
      data-testid="dashboard-page"
    >
      <div className="mx-auto w-full max-w-3xl px-4 py-6">
        <h1 className="text-base font-semibold text-[var(--text-primary)] mb-3">
          Dashboard
        </h1>
        <div className="rounded border border-[var(--border-primary)] bg-[var(--bg-secondary)] overflow-hidden">
          <ActiveOperatorSurfaces />
        </div>
      </div>
    </div>
  );
}
