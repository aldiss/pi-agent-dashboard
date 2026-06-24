/**
 * Tests for session grouping after jj removal.
 * All jj-specific workspace-root/clustering tests removed.
 */
import { describe, it, expect } from "vitest";
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import {
  groupSessionsByDirectory,
  filterStaleSessions,
  classifyTier,
  groupSessionsByTier,
  SESSION_TIER_ORDER,
} from "../session-grouping.js";

function mk(
  id: string,
  cwd: string,
  startedAt: number,
): DashboardSession {
  return {
    id,
    cwd,
    source: "tui",
    status: "active",
    startedAt,
    tokensIn: 0,
    tokensOut: 0,
    cost: 0,
  } as DashboardSession;
}

describe("groupSessionsByDirectory", () => {
  it("sessions group by cwd (regression guard)", () => {
    const a = mk("a", "/repo", 100);
    const b = mk("b", "/other", 200);
    const { unpinned } = groupSessionsByDirectory([a, b], undefined, [], "linux");
    expect(unpinned).toHaveLength(2);
    const cwds = unpinned.map((g) => g.cwd).sort();
    expect(cwds).toEqual(["/other", "/repo"]);
  });

  it("sessions at same cwd group together", () => {
    const a = mk("a", "/repo", 100);
    const b = mk("b", "/repo", 200);
    const { unpinned } = groupSessionsByDirectory([a, b], undefined, [], "linux");
    expect(unpinned).toHaveLength(1);
    expect(unpinned[0]!.cwd).toBe("/repo");
    expect(unpinned[0]!.sessions.map((s) => s.id).sort()).toEqual(["a", "b"]);
  });

  it("ranks a folder with a live session above an ended-only folder, even when the ended folder is newer (Track 3, Fix S)", () => {
    // The operator pain: an active driver buried below newer-but-ended CC
    // folders. Active-first must win over raw recency across groups.
    const live = { ...mk("live", "/active-work", 100), status: "active" } as DashboardSession;
    const ended = { ...mk("ended", "/old-cc", 999), status: "ended" } as DashboardSession;
    const { unpinned } = groupSessionsByDirectory([ended, live], undefined, [], "linux");
    expect(unpinned.map((g) => g.cwd)).toEqual(["/active-work", "/old-cc"]);
  });

  it("within the live bucket, orders folders by lastActivityAt then startedAt desc (Track 3, Fix S)", () => {
    // Two live folders: the one with the more recent lastActivityAt wins,
    // even though its startedAt is older.
    const olderStartNewerActivity = {
      ...mk("a", "/recent-active", 100),
      status: "active",
      lastActivityAt: 5000,
    } as DashboardSession;
    const newerStart = { ...mk("b", "/recent-start", 200), status: "active" } as DashboardSession;
    const { unpinned } = groupSessionsByDirectory(
      [newerStart, olderStartNewerActivity],
      undefined,
      [],
      "linux",
    );
    expect(unpinned.map((g) => g.cwd)).toEqual(["/recent-active", "/recent-start"]);
  });
});

describe("filterStaleSessions", () => {
  const NOW = 1_000_000_000_000;
  const HOUR = 3_600_000;

  function mkStale(
    id: string,
    opts: Partial<DashboardSession> = {},
  ): DashboardSession {
    return {
      id,
      cwd: "/repo",
      source: "tui",
      status: "active",
      startedAt: NOW - 100 * HOUR,
      tokensIn: 0,
      tokensOut: 0,
      cost: 0,
      ...opts,
    } as DashboardSession;
  }

  it("returns input unchanged when hideStale is false", () => {
    const s = [mkStale("a"), mkStale("b")];
    expect(filterStaleSessions(s, 24, false, NOW)).toEqual(s);
  });

  it("returns input unchanged when threshold <= 0", () => {
    const s = [mkStale("a")];
    expect(filterStaleSessions(s, 0, true, NOW)).toEqual(s);
    expect(filterStaleSessions(s, -5, true, NOW)).toEqual(s);
  });

  it("hides sessions with no activity beyond threshold", () => {
    const fresh = mkStale("fresh", { lastActivityAt: NOW - 1 * HOUR });
    const stale = mkStale("stale", { lastActivityAt: NOW - 48 * HOUR });
    const result = filterStaleSessions([fresh, stale], 24, true, NOW);
    expect(result.map((s) => s.id)).toEqual(["fresh"]);
  });

  it("uses max(lastActivityAt, startedAt) when lastActivityAt missing", () => {
    const freshlyStarted = mkStale("x", { startedAt: NOW - 1 * HOUR }); // no lastActivityAt
    const ancient = mkStale("y", { startedAt: NOW - 100 * HOUR });
    const result = filterStaleSessions([freshlyStarted, ancient], 24, true, NOW);
    expect(result.map((s) => s.id)).toEqual(["x"]);
  });

  it("never hides the currently-selected session", () => {
    const stale = mkStale("stale", { lastActivityAt: NOW - 100 * HOUR });
    const result = filterStaleSessions([stale], 24, true, NOW, "stale");
    expect(result.map((s) => s.id)).toEqual(["stale"]);
  });

  it("does not hide ended sessions (governed elsewhere)", () => {
    const stale = mkStale("ended", {
      status: "ended",
      lastActivityAt: NOW - 100 * HOUR,
    });
    const result = filterStaleSessions([stale], 24, true, NOW);
    expect(result.map((s) => s.id)).toEqual(["ended"]);
  });
});

describe("classifyTier", () => {
  function s(overrides: Partial<DashboardSession>): DashboardSession {
    return {
      id: "x",
      cwd: "/x",
      source: "tui",
      status: "active",
      startedAt: 0,
      tokensIn: 0,
      tokensOut: 0,
      cost: 0,
      ...overrides,
    } as DashboardSession;
  }

  it("classifies subagent-worker-<hex> as worker (by name)", () => {
    expect(classifyTier(s({ name: "subagent-worker-3f4a9b" }))).toBe("worker");
    expect(classifyTier(s({ name: "subagent-worker-0" }))).toBe("worker");
  });

  it("classifies cell-internal worker by sessionFile path", () => {
    expect(
      classifyTier(
        s({
          name: "random-name",
          source: "tmux",
          sessionFile: "/home/user/.pi/cells/foo/run-3/session.jsonl",
        }),
      ),
    ).toBe("worker");
  });

  it("classifies standing-crew canonical names anchored at start", () => {
    expect(classifyTier(s({ name: "Bert" }))).toBe("standing-crew");
    expect(classifyTier(s({ name: "Joan-tenure-25" }))).toBe("standing-crew");
    expect(classifyTier(s({ name: "Peggy-live-8" }))).toBe("standing-crew");
    expect(classifyTier(s({ name: "Lane" }))).toBe("standing-crew");
    expect(classifyTier(s({ name: "Pete-qa" }))).toBe("standing-crew");
    expect(classifyTier(s({ name: "Faye-tenure-2" }))).toBe("standing-crew");
    expect(classifyTier(s({ name: "Don-tenure-1" }))).toBe("standing-crew");
  });

  it("is case-insensitive for standing-crew canonical names", () => {
    expect(classifyTier(s({ name: "bert" }))).toBe("standing-crew");
    expect(classifyTier(s({ name: "JOAN-tenure-1" }))).toBe("standing-crew");
  });

  it("does NOT match standing-crew names that are not anchored at start", () => {
    expect(classifyTier(s({ name: "NotJoan" }))).not.toBe("standing-crew");
    expect(classifyTier(s({ name: "my-bert-thing" }))).not.toBe("standing-crew");
  });

  it("classifies TUI sessions as operator-chat-pane (after worker/standing-crew checks)", () => {
    expect(classifyTier(s({ name: "my-pi", source: "tui" }))).toBe("operator-chat-pane");
  });

  it("classifies tmux sessions with cell-executor in name", () => {
    expect(
      classifyTier(s({ name: "cell-executor-foo", source: "tmux", cwd: "/x" })),
    ).toBe("cell-executor");
  });

  it("classifies themed-name tmux session under /.pi/cells/ as cell-executor", () => {
    expect(
      classifyTier(
        s({
          name: "OakHawk",
          source: "tmux",
          cwd: "/home/user/.pi/cells/foo/v1",
        }),
      ),
    ).toBe("cell-executor");
    expect(
      classifyTier(
        s({
          name: "UltraMoon",
          source: "tmux",
          cwd: "/home/user/.pi/cells/bar",
        }),
      ),
    ).toBe("cell-executor");
  });

  it("classifies themed-name tmux session with cell-indicator substring in name", () => {
    expect(
      classifyTier(s({ name: "OakHawk-cell", source: "tmux", cwd: "/x" })),
    ).toBe("cell-executor");
    expect(
      classifyTier(s({ name: "FastEphemeralX", source: "tmux", cwd: "/x" })),
    ).toBe("cell-executor");
  });

  it("falls through to other for tmux sessions with no cell indicators", () => {
    expect(
      classifyTier(s({ name: "OakHawk", source: "tmux", cwd: "/random/path" })),
    ).toBe("other");
    expect(
      classifyTier(s({ name: "random-tmux", source: "tmux", cwd: "/x" })),
    ).toBe("other");
  });

  it("falls through to other for unknown sources", () => {
    expect(
      classifyTier(s({ name: "x", source: "unknown", cwd: "/x" })),
    ).toBe("other");
  });

  it("prioritizes worker classification over standing-crew if name shape matches", () => {
    // subagent-worker name pattern wins even if also tmux + themed-name + cells cwd
    expect(
      classifyTier(
        s({
          name: "subagent-worker-abc",
          source: "tmux",
          cwd: "/home/.pi/cells/x",
        }),
      ),
    ).toBe("worker");
  });
});

describe("groupSessionsByTier", () => {
  function s(name: string, overrides: Partial<DashboardSession> = {}): DashboardSession {
    return {
      id: name,
      cwd: "/x",
      name,
      source: "tui",
      status: "active",
      startedAt: 0,
      tokensIn: 0,
      tokensOut: 0,
      cost: 0,
      ...overrides,
    } as DashboardSession;
  }

  it("returns map with tiers in canonical order", () => {
    const sessions = [
      s("subagent-worker-1"),
      s("Bert"),
      s("my-pi", { source: "tui" }),
      s("OakHawk", { source: "tmux", cwd: "/home/.pi/cells/x" }),
    ];
    const result = groupSessionsByTier(sessions);
    expect([...result.keys()]).toEqual([
      "standing-crew",
      "cell-executor",
      "operator-chat-pane",
      "worker",
    ]);
  });

  it("omits empty tiers", () => {
    const result = groupSessionsByTier([s("Bert")]);
    expect([...result.keys()]).toEqual(["standing-crew"]);
  });

  it("places each session under its classified tier", () => {
    const bert = s("Bert");
    const worker = s("subagent-worker-1");
    const result = groupSessionsByTier([bert, worker]);
    expect(result.get("standing-crew")?.map((x) => x.id)).toEqual(["Bert"]);
    expect(result.get("worker")?.map((x) => x.id)).toEqual(["subagent-worker-1"]);
  });

  it("returns empty map for empty input", () => {
    expect(groupSessionsByTier([]).size).toBe(0);
  });
});

describe("SESSION_TIER_ORDER", () => {
  it("is the canonical 5-element order", () => {
    expect(SESSION_TIER_ORDER).toEqual([
      "standing-crew",
      "cell-executor",
      "operator-chat-pane",
      "worker",
      "other",
    ]);
  });
});
