import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";

/**
 * Pick the timestamp the session-card relative-time badge should anchor to.
 *
 * Precedence:
 *  - `status === "ended"` → `endedAt` (then `lastActivityAt`, then `startedAt`)
 *  - else → `lastActivityAt ?? startedAt`
 *
 * `lastActivityAt` is server-stamped on activity events (`isActivityEvent`)
 * and seeded at server start from the events.jsonl mtime, so a fresh dashboard
 * does not "reset" all idle session badges to "0s".
 *
 * See change: session-card-last-activity-badge (design.md § "Render precedence").
 */
export function selectBadgeTimestamp(session: DashboardSession): number {
  if (session.status === "ended") {
    return session.endedAt ?? session.lastActivityAt ?? session.startedAt;
  }
  return session.lastActivityAt ?? session.startedAt;
}

/**
 * The canonical activity timestamp used to age-band a session (build-2 P0
 * fix #11). Same precedence as {@link selectBadgeTimestamp}:
 *  - `ended` → `endedAt ?? lastActivityAt ?? startedAt`
 *  - else    → `lastActivityAt ?? startedAt`
 *
 * ADDS a `Math.max(..., startedAt)` stale guard so a row whose `endedAt` /
 * `lastActivityAt` is somehow OLDER than `startedAt` (clock skew, a stale
 * persisted value, or a partially-populated row) can never produce a
 * timestamp that mis-bands the session into a "way too old" bucket. The
 * guard also means the return is ALWAYS a finite number for a well-formed
 * session (every session has a numeric `startedAt`), which kills the `NaN`
 * misbanding that an `undefined - now` age computation would produce.
 *
 * Pure. Callers compute `now - activityTimestamp(session)` for the age.
 * See change: build-2-dashboard-v3.
 */
export function activityTimestamp(session: DashboardSession): number {
  const base =
    session.status === "ended"
      ? session.endedAt ?? session.lastActivityAt ?? session.startedAt
      : session.lastActivityAt ?? session.startedAt;
  // Stale guard: never return a basis older than startedAt. `startedAt` is the
  // one field guaranteed present, so this also guarantees a finite result.
  return Math.max(base ?? session.startedAt, session.startedAt);
}
