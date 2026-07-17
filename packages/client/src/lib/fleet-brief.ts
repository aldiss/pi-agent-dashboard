/**
 * computeFleetBrief — the pure fleet-brief contract (build-2 P0 fix #9).
 *
 * The fleet-brief reads the WHOLE session map + the operator surfaces and
 * surfaces "what needs me" as click-throughs REGARDLESS of tier / pin /
 * collapse. That IS the global escalation lane — there is no second one.
 *
 * Two input sources, one ranked output list:
 *   1. Sessions in band-1 (needs-you): `currentTool === "ask_user"` (input
 *      requested) OR `unseenServerError` (an unattended turn errored). These
 *      are the fleet-wide observability property — an UNVISITED errored
 *      session (incl. a dark card) MUST appear here.
 *   2. Operator surfaces whose `operator_action` is NOT `none` — every
 *      `push` / `ratify` / `review` / `decide` is included (NOT time-sorted
 *      only): each is a standing operator obligation.
 *
 * EXPLICIT contract (closes r2 MAJOR 4): the ranking is by KIND first
 * (action priority), then recency within a kind — a `push` surface is never
 * dropped merely because newer informational rows exist.
 *
 * Pure — no I/O, no `Date.now()`. Unit-tested (incl. "push is included").
 * See change: build-2-dashboard-v3.
 */
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import { isNeedsYou } from "./card-state.js";

/** Operator action a surface asks of the operator (mirrors ActiveOperatorSurfaces). */
export type OperatorAction = "none" | "ratify" | "push" | "review" | "decide";

/** Minimal surface shape the brief consumes (subset of `ActiveSurface`). */
export interface FleetBriefSurface {
  id: string;
  operator_action?: OperatorAction;
  timestamp?: string;
  brief_description?: string;
  url?: string | null;
  path?: string | null;
}

/** A single ranked entry in the fleet brief. */
export interface FleetBriefItem {
  /** Discriminates a session need from a surface obligation. */
  kind: "session" | "surface";
  /** Stable id — the sessionId or the surface id. */
  id: string;
  /** Why this entry needs the operator. */
  reason: "server-error" | "ask-user" | OperatorAction;
  /** Human label for the brief row. */
  label: string;
  /** Lower sorts first (most urgent). */
  priority: number;
  /** Epoch ms used to break ties within a priority band (newer first). */
  at: number;
  /** The source session (kind === "session"). */
  session?: DashboardSession;
  /** The source surface (kind === "surface"). */
  surface?: FleetBriefSurface;
}

/**
 * Priority ladder (lower = more urgent). Session needs outrank surface
 * obligations because a live agent blocked on input / crashed is time-
 * critical, whereas a surface obligation is a standing queue item.
 *
 *   0  session: server-error   (an unattended crash — nobody saw it)
 *   1  session: ask-user       (a live agent is blocked waiting)
 *   2  surface: decide         (an operator decision gates progress)
 *   3  surface: ratify         (a one-action approval)
 *   4  surface: review         (needs eyes)
 *   5  surface: push           (an operator push obligation)
 */
const SESSION_PRIORITY: Record<"server-error" | "ask-user", number> = {
  "server-error": 0,
  "ask-user": 1,
};
const SURFACE_PRIORITY: Record<Exclude<OperatorAction, "none">, number> = {
  decide: 2,
  ratify: 3,
  review: 4,
  push: 5,
};

function sessionLabel(s: DashboardSession): string {
  return s.name?.trim() || s.firstMessage?.trim() || s.cwd?.split("/").pop() || s.id;
}

function parseTimestamp(iso: string | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Compute the ranked fleet brief from sessions + surfaces.
 *
 * @param sessions all known sessions (the whole map — tier/pin/collapse
 *                 agnostic, that's the point).
 * @param surfaces operator surfaces (from ActiveOperatorSurfaces).
 */
export function computeFleetBrief(
  sessions: readonly DashboardSession[],
  surfaces: readonly FleetBriefSurface[],
): FleetBriefItem[] {
  const items: FleetBriefItem[] = [];

  for (const s of sessions) {
    if (!isNeedsYou(s)) continue;
    // A session may be both errored and awaiting input; surface the more
    // urgent (server-error) reason but still one row per session.
    const reason: "server-error" | "ask-user" =
      s.unseenServerError === true ? "server-error" : "ask-user";
    items.push({
      kind: "session",
      id: s.id,
      reason,
      label: sessionLabel(s),
      priority: SESSION_PRIORITY[reason],
      at: s.lastActivityAt ?? s.endedAt ?? s.startedAt,
      session: s,
    });
  }

  for (const surface of surfaces) {
    const action = surface.operator_action ?? "none";
    // EVERY non-none action is included — push/ratify/review/decide alike.
    if (action === "none") continue;
    items.push({
      kind: "surface",
      id: surface.id,
      reason: action,
      label: surface.brief_description?.trim() || surface.id,
      priority: SURFACE_PRIORITY[action],
      at: parseTimestamp(surface.timestamp),
      surface,
    });
  }

  // Rank: priority ascending (most urgent first), then recency within a band
  // (newer `at` first). Stable for equal keys so input order is preserved.
  return items
    .map((item, idx) => ({ item, idx }))
    .sort((a, b) => {
      if (a.item.priority !== b.item.priority) return a.item.priority - b.item.priority;
      if (a.item.at !== b.item.at) return b.item.at - a.item.at;
      return a.idx - b.idx;
    })
    .map(({ item }) => item);
}

// ── Finished-unseen window (build-2 P0 fix #5) ─────────────────────────────

/**
 * A finished session older than this is NOT "unseen work" worth surfacing —
 * it's history. Bounds the finished-unseen set on the OLD side so a cleared
 * localStorage never admits a flood of ancient corpses. 6h.
 */
export const FINISHED_MAX_AGE_MS = 6 * 3600 * 1000;

/** Hard cap on finished-unseen rows in the brief (defense against a burst). */
export const FINISHED_UNSEEN_ROW_CAP = 12;

/**
 * Genuine completion time of a finished session, guarded against a hygiene /
 * discovery re-stamp (build-2 P0 fix #5).
 *
 * Discovery + `reconcileSessionHygiene` can stamp an OLD row with a FRESH
 * `endedAt`. A genuinely just-finished row has BOTH a recent `endedAt` AND a
 * recent `lastActivityAt`; a re-stamped corpse has a fresh `endedAt` but a
 * STALE `lastActivityAt`. Taking the OLDER of the two means a fresh re-stamp
 * cannot lift a corpse into the window. Pure.
 */
export function genuineCompletionTime(s: DashboardSession): number {
  const ended = s.endedAt ?? s.lastActivityAt ?? s.startedAt;
  const activity = s.lastActivityAt ?? s.endedAt ?? s.startedAt;
  return Math.min(ended, activity);
}

/**
 * First-run-safe cutoff for the finished-unseen window (build-2 P0 fix #5).
 *
 * `max(validLastBriefViewAt, now - FINISHED_MAX_AGE)`:
 *  - a missing / cleared / non-positive `lastBriefViewAt` (first run) yields
 *    the baseline `now - maxAgeMs` — NEVER `now` (which would discard the
 *    operator's very first view) and NEVER `0` (which would admit every
 *    ancient corpse).
 *  - a real `lastBriefViewAt` clamps UP to the baseline so an operator who
 *    was away for days still only sees the last `maxAgeMs` of completions.
 * Pure.
 */
export function finishedUnseenCutoff(
  lastBriefViewAt: number | null | undefined,
  now: number,
  maxAgeMs: number = FINISHED_MAX_AGE_MS,
): number {
  const baseline = now - maxAgeMs;
  if (lastBriefViewAt == null || !Number.isFinite(lastBriefViewAt) || lastBriefViewAt <= 0) {
    return baseline;
  }
  return Math.max(lastBriefViewAt, baseline);
}

/**
 * Select the finished-unseen sessions for the brief: ended, not hidden, and
 * NOT already needs-you (those rank in the higher band), whose genuine
 * completion falls in `[cutoff, now]`. Sorted newest-completion-first and
 * capped. Pure.
 */
export function selectFinishedUnseen(
  sessions: readonly DashboardSession[],
  cutoff: number,
  now: number,
  cap: number = FINISHED_UNSEEN_ROW_CAP,
): DashboardSession[] {
  const out: DashboardSession[] = [];
  for (const s of sessions) {
    if (s.status !== "ended" || s.hidden) continue;
    // A still-needs-you ended row (unseen error) is surfaced by the needs
    // band, not here — don't double-list it.
    if (isNeedsYou(s)) continue;
    const c = genuineCompletionTime(s);
    if (c >= cutoff && c <= now) out.push(s);
  }
  out.sort((a, b) => genuineCompletionTime(b) - genuineCompletionTime(a));
  return out.slice(0, Math.max(0, cap));
}
