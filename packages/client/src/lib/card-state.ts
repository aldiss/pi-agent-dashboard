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
 *  - `needs`   — the operator must act: unseen server error OR `ask_user`.
 *                Retained regardless of age (never decays).
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
 * Is this session in band-1 (needs-you) — `currentTool === "ask_user"` OR an
 * unseen server error? Fleet-wide: `currentTool` broadcasts fleet-wide and
 * `unseenServerError` persists across registration, so a needy session ranks
 * regardless of tier/pin/collapse. (build-2 P0 fix #3.)
 *
 * NOTE: an `ended` session that still carries `unseenServerError` is STILL
 * needs-you — the error outlived the process and the operator never saw it.
 */
export function isNeedsYou(session: DashboardSession): boolean {
  return session.currentTool === "ask_user" || session.unseenServerError === true;
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
  // Band-1 first — needs-you is retained through age-decay and even survives
  // the session ending (an unseen error on a dead session still needs you).
  if (session.unseenServerError === true) {
    return { ageBand: "needs", reason: "server-error" };
  }
  if (session.currentTool === "ask_user") {
    return { ageBand: "needs", reason: "ask-user" };
  }

  // Ended (and not needs-you) → dormant. Alive-only bands below.
  if (session.status === "ended") {
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
