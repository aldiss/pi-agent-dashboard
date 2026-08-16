/**
 * ONE pure card-state derivation (build-2 P0 fix #13).
 *
 * The single source of truth for a session card's age-band + WHY it is banded.
 * Pure, unit-testable, no I/O, no localStorage reads (the caller injects
 * `staleHours` — reuse `dashboard:staleHours` — and `now`).
 *
 * Design constraints (spec §13):
 *  - error / ask-user are RETAINED THROUGH AGE-DECAY: a session that needs the
 *    operator (server error unseen, or awaiting `ask_user`) stays band `needs`
 *    no matter how old it is. Only sessions that DON'T need you decay by age.
 *    Age-decay only — DEATH is different: an unseen error outlives the process,
 *    an unanswered `ask_user` does not (nobody can answer a dead modal).
 *  - the within-band engagement modifier is DROPPED (it was null on all live
 *    sessions anyway) — this derivation returns only `{ ageBand, reason }`.
 *  - alive-only: an `ended` session is never `needs`/`fresh`/`aging` — it is
 *    `dormant`. The fleet count is alive-only; corpses do not inflate it.
 *
 * See change: build-2-dashboard-v3.
 */
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import { activityTimestamp } from "./session-card-time.js";

/**
 * Coarse band for a session card, most-urgent → least:
 *  - `needs`   — the operator must act: unseen server error OR a LIVE `ask_user`.
 *                Retained regardless of age (never decays). An ended session on
 *                `ask_user` is `dormant`, not `needs`.
 *  - `fresh`   — alive, active within the stale window.
 *  - `aging`   — alive, quiet longer than the stale window (still not ended).
 *  - `dormant` — ended (no longer alive).
 */
export type AgeBand = "needs" | "fresh" | "aging" | "dormant";

/** Why the card landed in its band — surfaced for tooltips + tests. */
export type CardStateReason =
  | "server-error"
  | "ask-user"
  | "active"
  | "stale"
  | "ended";

export interface CardState {
  ageBand: AgeBand;
  reason: CardStateReason;
}

/**
 * Ended, per the FIX-C3 convention already used by `session-grouping`
 * (`filterSessions`, `filterStaleSessions`, `stablePartitionByBand`): an
 * `endedAt` that is set IS a genuine end, even when a legacy/unprojected row
 * still carries a stale `status`. Reactivation clears `endedAt`, so
 * `endedAt != null` implies ended.
 */
function isEnded(session: DashboardSession): boolean {
  return session.status === "ended" || session.endedAt != null;
}

/**
 * Is this session in band-1 (needs-you) — an unseen server error, or a LIVE
 * `ask_user`? Fleet-wide: `currentTool` broadcasts fleet-wide and
 * `unseenServerError` persists across registration, so a needy session ranks
 * regardless of tier/pin/collapse. (build-2 P0 fix #3.)
 *
 * The two signals are NOT symmetric about death, and that asymmetry is the
 * whole rule:
 *  - an `ended` session carrying `unseenServerError` is STILL needs-you — the
 *    error outlived the process and the operator never saw it.
 *  - an `ended` session sitting on `ask_user` is NOT — the modal died with the
 *    process and NOBODY CAN ANSWER IT. Without the alive gate a dead prompt
 *    became a permanent operator obligation: the live `pi7-write` row
 *    (01a006b8…, status=ended, hidden=true, currentTool=ask_user) reappeared in
 *    purple Needs-You forever, because `currentTool` is never cleared on end.
 *
 * `stablePartitionByBand` already gated on ended before calling this, which is
 * why the sidebar looked correct while `computeFleetBrief` — which reads the
 * whole map — did not.
 */
export function isNeedsYou(session: DashboardSession): boolean {
  if (session.unseenServerError === true) return true;
  return session.currentTool === "ask_user" && !isEnded(session);
}

/**
 * Derive the pure card-state for a session.
 *
 * @param session   the session row
 * @param now       epoch ms (injected — never `Date.now()` inside, for testability)
 * @param staleHours hours of quiet before an alive session is `aging`
 *                    (reuse `dashboard:staleHours`; caller passes the value)
 */
export function deriveCardState(
  session: DashboardSession,
  now: number,
  staleHours: number,
): CardState {
  // Band-1 first — needs-you is retained through age-decay. An unseen error
  // even survives the session ending (it outlived the process and was never
  // seen). A dead `ask_user` does NOT: the ended check below claims it.
  if (session.unseenServerError === true) {
    return { ageBand: "needs", reason: "server-error" };
  }
  if (session.currentTool === "ask_user" && !isEnded(session)) {
    return { ageBand: "needs", reason: "ask-user" };
  }

  // Ended (and not needs-you) → dormant. This now also claims ended+ask_user,
  // which previously escaped above and banded `needs` forever. Alive-only
  // bands below.
  if (isEnded(session)) {
    return { ageBand: "dormant", reason: "ended" };
  }

  // Alive: fresh vs aging by the stale window. A non-positive / non-finite
  // staleHours disables aging (everything alive is fresh) — mirrors the
  // stale-filter's "<= 0 disables" contract.
  if (!Number.isFinite(staleHours) || staleHours <= 0) {
    return { ageBand: "fresh", reason: "active" };
  }
  const quietMs = now - activityTimestamp(session);
  const staleMs = staleHours * 3600 * 1000;
  if (quietMs >= staleMs) {
    return { ageBand: "aging", reason: "stale" };
  }
  return { ageBand: "fresh", reason: "active" };
}

/**
 * Alive-only fleet count (build-2 P0 fix #13 — "kill 963 active counting
 * corpses"). Counts sessions whose status is not `ended`. Pure.
 */
export function countAlive(sessions: readonly DashboardSession[]): number {
  let n = 0;
  for (const s of sessions) if (s.status !== "ended") n++;
  return n;
}
