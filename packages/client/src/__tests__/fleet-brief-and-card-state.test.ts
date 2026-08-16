import { describe, it, expect } from "vitest";
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import { computeFleetBrief, type FleetBriefSurface } from "../lib/fleet-brief.js";
import {
  finishedUnseenCutoff,
  genuineCompletionTime,
  selectFinishedUnseen,
  FINISHED_MAX_AGE_MS,
} from "../lib/fleet-brief.js";
import { deriveCardState, isNeedsYou, countAlive } from "../lib/card-state.js";
import { activityTimestamp } from "../lib/session-card-time.js";

/**
 * Pure fleet-brief + card-state + activity-timestamp derivations.
 * See change: build-2-dashboard-v3.
 */

function mk(overrides: Partial<DashboardSession>): DashboardSession {
  return {
    id: "s1",
    cwd: "/tmp/project",
    source: "tui",
    status: "idle",
    startedAt: 1_000,
    tokensIn: 0,
    tokensOut: 0,
    cost: 0,
    ...overrides,
  } as DashboardSession;
}

function surface(overrides: Partial<FleetBriefSurface>): FleetBriefSurface {
  return { id: "surf-1", operator_action: "none", ...overrides };
}

// ── computeFleetBrief ──────────────────────────────────────────────────────

describe("computeFleetBrief", () => {
  it("includes a push surface (load-bearing: every non-none action is in the brief)", () => {
    const items = computeFleetBrief([], [surface({ id: "deck-42", operator_action: "push" })]);
    const push = items.find((i) => i.id === "deck-42");
    expect(push).toBeDefined();
    expect(push!.reason).toBe("push");
    expect(push!.kind).toBe("surface");
  });

  it("includes every non-none operator action: push, ratify, review, decide", () => {
    const items = computeFleetBrief([], [
      surface({ id: "a", operator_action: "push" }),
      surface({ id: "b", operator_action: "ratify" }),
      surface({ id: "c", operator_action: "review" }),
      surface({ id: "d", operator_action: "decide" }),
      surface({ id: "e", operator_action: "none" }),
    ]);
    const ids = items.map((i) => i.id);
    expect(ids).toContain("a");
    expect(ids).toContain("b");
    expect(ids).toContain("c");
    expect(ids).toContain("d");
    expect(ids).not.toContain("e"); // none is excluded
  });

  it("an UNVISITED errored session ranks into the brief (fleet-wide observability)", () => {
    const items = computeFleetBrief(
      [mk({ id: "errored", unseenServerError: true })],
      [],
    );
    const entry = items.find((i) => i.id === "errored");
    expect(entry).toBeDefined();
    expect(entry!.reason).toBe("server-error");
  });

  it("an errored DARK card (ended + unseenServerError) still ranks into the brief", () => {
    const items = computeFleetBrief(
      [mk({ id: "dark", status: "ended", endedAt: 5_000, unseenServerError: true })],
      [],
    );
    expect(items.find((i) => i.id === "dark")).toBeDefined();
  });

  it("ranks session needs above surface obligations, and server-error above ask-user", () => {
    const items = computeFleetBrief(
      [
        mk({ id: "ask", currentTool: "ask_user" }),
        mk({ id: "err", unseenServerError: true }),
      ],
      [surface({ id: "push", operator_action: "push", timestamp: new Date(9_999_999).toISOString() })],
    );
    expect(items.map((i) => i.id)).toEqual(["err", "ask", "push"]);
  });

  it("is NOT time-sorted only: an old push outranks a newer review is false; kind priority wins", () => {
    // decide (older) must still outrank push (newer) — priority is by kind first.
    const items = computeFleetBrief([], [
      surface({ id: "push-new", operator_action: "push", timestamp: new Date(9_000).toISOString() }),
      surface({ id: "decide-old", operator_action: "decide", timestamp: new Date(1_000).toISOString() }),
    ]);
    expect(items.map((i) => i.id)).toEqual(["decide-old", "push-new"]);
  });

  it("excludes sessions that do not need the operator", () => {
    const items = computeFleetBrief([mk({ id: "calm", status: "idle" })], []);
    expect(items).toHaveLength(0);
  });

  it("emits one row per errored session even when also ask_user", () => {
    const items = computeFleetBrief(
      [mk({ id: "both", currentTool: "ask_user", unseenServerError: true })],
      [],
    );
    const rows = items.filter((i) => i.id === "both");
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("server-error"); // more urgent reason wins
  });
});

// ── isNeedsYou / deriveCardState ───────────────────────────────────────────

describe("isNeedsYou", () => {
  it("true for ask_user", () => {
    expect(isNeedsYou(mk({ currentTool: "ask_user" }))).toBe(true);
  });
  it("true for unseenServerError", () => {
    expect(isNeedsYou(mk({ unseenServerError: true }))).toBe(true);
  });
  it("false for a calm idle session", () => {
    expect(isNeedsYou(mk({ status: "idle" }))).toBe(false);
  });
});

describe("deriveCardState", () => {
  const now = 100_000_000;
  const staleHours = 24;

  it("server-error → needs, retained through age-decay (very old)", () => {
    const s = mk({ status: "idle", unseenServerError: true, startedAt: 1, lastActivityAt: 1 });
    expect(deriveCardState(s, now, staleHours)).toEqual({ ageBand: "needs", reason: "server-error" });
  });

  it("ask-user → needs even when quiet a long time", () => {
    const s = mk({ status: "idle", currentTool: "ask_user", lastActivityAt: 1 });
    expect(deriveCardState(s, now, staleHours)).toEqual({ ageBand: "needs", reason: "ask-user" });
  });

  it("an ended session that still carries unseenServerError is STILL needs", () => {
    const s = mk({ status: "ended", endedAt: 5, unseenServerError: true });
    expect(deriveCardState(s, now, staleHours).ageBand).toBe("needs");
  });

  it("ended + calm → dormant", () => {
    const s = mk({ status: "ended", endedAt: 5 });
    expect(deriveCardState(s, now, staleHours)).toEqual({ ageBand: "dormant", reason: "ended" });
  });

  it("alive + recent → fresh", () => {
    const s = mk({ status: "idle", lastActivityAt: now - 1000 });
    expect(deriveCardState(s, now, staleHours)).toEqual({ ageBand: "fresh", reason: "active" });
  });

  it("alive + quiet past stale window → aging", () => {
    const s = mk({ status: "idle", lastActivityAt: now - 25 * 3600 * 1000 });
    expect(deriveCardState(s, now, staleHours)).toEqual({ ageBand: "aging", reason: "stale" });
  });

  it("staleHours <= 0 disables aging (alive is always fresh)", () => {
    const s = mk({ status: "idle", lastActivityAt: 1 });
    expect(deriveCardState(s, now, 0).ageBand).toBe("fresh");
  });
});

describe("countAlive", () => {
  it("counts only non-ended sessions (kills corpse-inflation)", () => {
    const sessions = [
      mk({ id: "a", status: "idle" }),
      mk({ id: "b", status: "streaming" }),
      mk({ id: "c", status: "ended", endedAt: 5 }),
      mk({ id: "d", status: "ended", endedAt: 6 }),
    ];
    expect(countAlive(sessions)).toBe(2);
  });
});

// ── finished-unseen window (Fix #5) ────────────────────────────────────────

describe("finishedUnseenCutoff — first-run baseline safety", () => {
  const now = 1_000_000_000;

  it("missing lastView (first run) → now - maxAge, NEVER now and NEVER 0", () => {
    const cutoff = finishedUnseenCutoff(null, now);
    expect(cutoff).toBe(now - FINISHED_MAX_AGE_MS);
    expect(cutoff).not.toBe(now); // would discard the first view
    expect(cutoff).not.toBe(0); // would admit ancient corpses
  });

  it("cleared / non-positive lastView → baseline (never 0)", () => {
    expect(finishedUnseenCutoff(0, now)).toBe(now - FINISHED_MAX_AGE_MS);
    expect(finishedUnseenCutoff(-5, now)).toBe(now - FINISHED_MAX_AGE_MS);
    expect(finishedUnseenCutoff(NaN, now)).toBe(now - FINISHED_MAX_AGE_MS);
  });

  it("a recent lastView is honored (later than the baseline)", () => {
    const recent = now - 60_000;
    expect(finishedUnseenCutoff(recent, now)).toBe(recent);
  });

  it("an ancient lastView clamps UP to the baseline (away-for-days operator)", () => {
    const ancient = now - 10 * FINISHED_MAX_AGE_MS;
    expect(finishedUnseenCutoff(ancient, now)).toBe(now - FINISHED_MAX_AGE_MS);
  });
});

describe("genuineCompletionTime — hygiene re-stamp guard", () => {
  it("a truly-finished row (recent endedAt AND lastActivityAt) reports the recent time", () => {
    const s = mk({ status: "ended", endedAt: 5_000, lastActivityAt: 4_900 });
    expect(genuineCompletionTime(s)).toBe(4_900);
  });

  it("a re-stamped corpse (fresh endedAt, STALE lastActivityAt) reports the STALE time", () => {
    // Discovery/hygiene stamped a fresh endedAt onto an old row; the older
    // lastActivityAt wins so it cannot be lifted into the window.
    const s = mk({ status: "ended", endedAt: 9_999_999, lastActivityAt: 100 });
    expect(genuineCompletionTime(s)).toBe(100);
  });
});

describe("selectFinishedUnseen", () => {
  const now = 1_000_000;

  it("includes finished sessions inside the window, newest first, capped", () => {
    const cutoff = now - FINISHED_MAX_AGE_MS;
    const sessions = [
      mk({ id: "old", status: "ended", endedAt: cutoff - 1, lastActivityAt: cutoff - 1 }), // before window
      mk({ id: "recent1", status: "ended", endedAt: now - 1000, lastActivityAt: now - 1000 }),
      mk({ id: "recent2", status: "ended", endedAt: now - 500, lastActivityAt: now - 500 }),
    ];
    const out = selectFinishedUnseen(sessions, cutoff, now);
    expect(out.map((s) => s.id)).toEqual(["recent2", "recent1"]);
  });

  it("excludes hidden, alive, and still-needs-you rows", () => {
    const cutoff = now - FINISHED_MAX_AGE_MS;
    const sessions = [
      mk({ id: "hidden", status: "ended", endedAt: now - 100, lastActivityAt: now - 100, hidden: true }),
      mk({ id: "alive", status: "idle", lastActivityAt: now - 100 }),
      mk({ id: "needs", status: "ended", endedAt: now - 100, lastActivityAt: now - 100, unseenServerError: true }),
      mk({ id: "ok", status: "ended", endedAt: now - 100, lastActivityAt: now - 100 }),
    ];
    expect(selectFinishedUnseen(sessions, cutoff, now).map((s) => s.id)).toEqual(["ok"]);
  });

  it("respects the row cap", () => {
    const cutoff = now - FINISHED_MAX_AGE_MS;
    const sessions = Array.from({ length: 30 }, (_, i) =>
      mk({ id: `s${i}`, status: "ended", endedAt: now - i - 1, lastActivityAt: now - i - 1 }),
    );
    expect(selectFinishedUnseen(sessions, cutoff, now, 12)).toHaveLength(12);
  });

  it("a re-stamped corpse is NOT admitted despite a fresh endedAt", () => {
    const cutoff = now - FINISHED_MAX_AGE_MS;
    const corpse = mk({ id: "corpse", status: "ended", endedAt: now - 100, lastActivityAt: cutoff - 5000 });
    expect(selectFinishedUnseen([corpse], cutoff, now)).toHaveLength(0);
  });
});

// ── activityTimestamp (Fix #11 — kills NaN misbanding) ─────────────────────

describe("activityTimestamp", () => {
  it("ended → endedAt when present", () => {
    expect(activityTimestamp(mk({ status: "ended", endedAt: 9_000, startedAt: 1_000 }))).toBe(9_000);
  });

  it("ended → falls back to lastActivityAt then startedAt", () => {
    expect(activityTimestamp(mk({ status: "ended", lastActivityAt: 4_000, startedAt: 1_000 }))).toBe(4_000);
    expect(activityTimestamp(mk({ status: "ended", startedAt: 1_000 }))).toBe(1_000);
  });

  it("alive → lastActivityAt ?? startedAt", () => {
    expect(activityTimestamp(mk({ status: "idle", lastActivityAt: 7_000, startedAt: 1_000 }))).toBe(7_000);
    expect(activityTimestamp(mk({ status: "idle", startedAt: 1_000 }))).toBe(1_000);
  });

  it("stale guard: never older than startedAt (kills NaN / clock-skew misbanding)", () => {
    // endedAt older than startedAt (skew) → clamped up to startedAt.
    expect(activityTimestamp(mk({ status: "ended", endedAt: 500, startedAt: 1_000 }))).toBe(1_000);
  });

  it("always returns a finite number for a well-formed session", () => {
    expect(Number.isFinite(activityTimestamp(mk({ status: "idle", startedAt: 1_000 })))).toBe(true);
  });
});

// ── ended + ask_user is NOT a standing operator obligation ──────────────────
// Live defect: a dead `ask_user` modal (session ended, process gone) kept a
// permanent purple Needs-You row in the fleet brief. `isNeedsYou` had no alive
// gate on ask_user, and `deriveCardState` tested ask_user BEFORE ended.
// Real row: id 01a006b8…, status=ended, hidden=true, currentTool=ask_user,
// unseenServerError=false. An unseen ERROR still outlives the process; an
// unanswered modal on a dead process does not — nobody can answer it.
describe("ended + ask_user (dead modal must not be a permanent obligation)", () => {
  const now = 100_000_000;
  const staleHours = 24;

  it("live ask_user is STILL needs-you (the fix must not disarm the real case)", () => {
    expect(isNeedsYou(mk({ status: "idle", currentTool: "ask_user" }))).toBe(true);
    expect(isNeedsYou(mk({ status: "active", currentTool: "ask_user" }))).toBe(true);
  });

  it("ended + ask_user is NOT needs-you", () => {
    expect(isNeedsYou(mk({ status: "ended", endedAt: 5_000, currentTool: "ask_user" }))).toBe(false);
  });

  it("endedAt-set-but-stale-status + ask_user is NOT needs-you (FIX-C3 convention)", () => {
    // A legacy/unprojected row can carry endedAt while status still reads idle.
    // session-grouping already treats endedAt != null as ended; card-state must agree.
    expect(isNeedsYou(mk({ status: "idle", endedAt: 5_000, currentTool: "ask_user" }))).toBe(false);
  });

  it("ended + unseenServerError is STILL needs-you (unchanged)", () => {
    expect(isNeedsYou(mk({ status: "ended", endedAt: 5_000, unseenServerError: true }))).toBe(true);
  });

  it("ended + BOTH → needs, and the reason is server-error not ask-user", () => {
    const s = mk({ status: "ended", endedAt: 5_000, currentTool: "ask_user", unseenServerError: true });
    expect(isNeedsYou(s)).toBe(true);
    expect(deriveCardState(s, now, staleHours)).toEqual({ ageBand: "needs", reason: "server-error" });
  });

  it("ended + ask_user derives dormant/ended, not needs/ask-user", () => {
    const s = mk({ status: "ended", endedAt: 5_000, currentTool: "ask_user" });
    expect(deriveCardState(s, now, staleHours)).toEqual({ ageBand: "dormant", reason: "ended" });
  });

  it("computeFleetBrief emits ZERO rows for an ended ask_user session", () => {
    const items = computeFleetBrief(
      [mk({ id: "pi7-write", status: "ended", endedAt: 5_000, hidden: true, currentTool: "ask_user" })],
      [],
    );
    expect(items.filter((i) => i.id === "pi7-write")).toHaveLength(0);
  });

  it("computeFleetBrief still emits the live ask_user beside the dead one", () => {
    const items = computeFleetBrief(
      [
        mk({ id: "dead", status: "ended", endedAt: 5_000, currentTool: "ask_user" }),
        mk({ id: "alive", status: "idle", currentTool: "ask_user" }),
      ],
      [],
    );
    expect(items.map((i) => i.id)).toContain("alive");
    expect(items.map((i) => i.id)).not.toContain("dead");
  });
});
