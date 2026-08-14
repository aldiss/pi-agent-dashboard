/**
 * Tests for session grouping after jj removal.
 * All jj-specific workspace-root/clustering tests removed.
 */
import { describe, it, expect } from "vitest";
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import {
  groupSessionsByDirectory,
  groupTierByFolder,
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

  it("C4: keeps a bridge-connected session with old timestamps; hides the disconnected control", () => {
    const connected = mkStale("connected", { lastActivityAt: NOW - 48 * HOUR, bridgeConnected: true });
    const control = mkStale("control", { lastActivityAt: NOW - 48 * HOUR, bridgeConnected: false });
    const result = filterStaleSessions([connected, control], 24, true, NOW);
    expect(result.map((s) => s.id)).toEqual(["connected"]);
  });

  it("C6: an old-but-connected standing seat (Faye-class) stays visible", () => {
    // Old lastActivityAt + old startedAt, but the bridge socket is live -> never hidden.
    const faye = mkStale("faye", { startedAt: NOW - 500 * HOUR, lastActivityAt: NOW - 500 * HOUR, bridgeConnected: true });
    const result = filterStaleSessions([faye], 24, true, NOW);
    expect(result.map((s) => s.id)).toEqual(["faye"]);
  });

  it("FIX-C3 client: an endedAt-set row is treated as ended (exempt from the stale cull)", () => {
    const endedStale = mkStale("endedAt-set", { status: "idle", endedAt: NOW - 50 * HOUR, lastActivityAt: NOW - 50 * HOUR });
    const result = filterStaleSessions([endedStale], 24, true, NOW);
    expect(result.map((s) => s.id)).toEqual(["endedAt-set"]);
  });

  it("FIX-C2 STRICT: bridgeConnected only exempts on === true (absent/false falls through to cutoff)", () => {
    const undef = mkStale("undef", { lastActivityAt: NOW - 48 * HOUR }); // no bridgeConnected -> stale-hidden
    const result = filterStaleSessions([undef], 24, true, NOW);
    expect(result.map((s) => s.id)).toEqual([]);
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
    expect(classifyTier(s({ name: "Alice" }))).toBe("standing-crew");
    // Dawn — the 10th seat (L0.5f recorder, ratified 2026-07-30).
    expect(classifyTier(s({ name: "Dawn" }))).toBe("standing-crew");
  });

  it("classifies standing-crew names with a ' — status' suffix (the live dashboard name shape)", () => {
    // Live sessions carry a status-suffix after an em-dash, e.g. the mesh status-string.
    // The boundary must accept space/em-dash, not only hyphen/end (Don/Alice fix 2026-06-26).
    expect(classifyTier(s({ name: "Don — Don tenure-4 operator-language layer" }))).toBe("standing-crew");
    expect(classifyTier(s({ name: "Alice — L0.4 cross-model architect" }))).toBe("standing-crew");
    expect(classifyTier(s({ name: "Joan tenure-64 — system-evolution" }))).toBe("standing-crew");
  });

  it("is case-insensitive for standing-crew canonical names", () => {
    expect(classifyTier(s({ name: "bert" }))).toBe("standing-crew");
    expect(classifyTier(s({ name: "JOAN-tenure-1" }))).toBe("standing-crew");
  });

  it("does NOT match standing-crew names that are not anchored at start", () => {
    expect(classifyTier(s({ name: "NotJoan" }))).not.toBe("standing-crew");
    expect(classifyTier(s({ name: "my-bert-thing" }))).not.toBe("standing-crew");
  });

  it("does NOT over-match a longer word that merely starts with a crew name", () => {
    // The negative-lookahead boundary must reject a crew name immediately followed by a letter.
    expect(classifyTier(s({ name: "Donna" }))).not.toBe("standing-crew");
    expect(classifyTier(s({ name: "Petersen" }))).not.toBe("standing-crew");
    expect(classifyTier(s({ name: "Bertram" }))).not.toBe("standing-crew");
    expect(classifyTier(s({ name: "Dawning" }))).not.toBe("standing-crew");
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

  it("classifies pi-drivers (tmux + nos-cells/ cwd) as drivers", () => {
    // Live driver shapes verified own-hand against the running dashboard:
    // single-word PascalCase names, compound names, and a -driver cell-id —
    // ALL keyed on the nos-cells/ cwd, not a themed-name regex.
    const base = "/Users/x/.pi/orchestration-state/nos-cells";
    expect(classifyTier(s({ name: "Vault", source: "tmux", cwd: `${base}/cell-git-repo-binding` }))).toBe("drivers");
    expect(classifyTier(s({ name: "Harbor", source: "tmux", cwd: `${base}/intake-attention-protection-driver` }))).toBe("drivers");
    expect(classifyTier(s({ name: "Keystone", source: "tmux", cwd: `${base}/architect-pair-driver` }))).toBe("drivers");
    expect(classifyTier(s({ name: "BrightUnion", source: "tmux", cwd: `${base}/handover-reliability-driver` }))).toBe("drivers");
  });

  it("classifies a null-named driver under nos-cells/ as drivers (name-agnostic)", () => {
    // The arch-diagram-driver tmux peer has no name — cwd is the discriminator.
    expect(
      classifyTier(s({ name: undefined, source: "tmux", cwd: "/Users/x/.pi/orchestration-state/nos-cells/arch-diagram-driver" })),
    ).toBe("drivers");
  });

  it("classifies a -driver cell-id outside nos-cells/ as drivers (guarded fallback)", () => {
    expect(
      classifyTier(s({ name: "Solo", source: "tmux", cwd: "/Users/x/work/my-thing-driver" })),
    ).toBe("drivers");
  });

  it("does NOT classify a /.pi/cells/ session as drivers even when its path contains -driver", () => {
    // The -driver fallback is guarded against /.pi/cells/ so cell-executors stay distinct.
    expect(
      classifyTier(s({ name: "OakHawk", source: "tmux", cwd: "/Users/x/.pi/cells/some-driver-cell/v1" })),
    ).toBe("cell-executor");
  });

  it("keeps a standing-crew member out of drivers even under nos-cells/ (order-safe)", () => {
    expect(
      classifyTier(s({ name: "Joan-tenure-64", source: "tmux", cwd: "/Users/x/.pi/orchestration-state/nos-cells/architect-pair-driver" })),
    ).toBe("standing-crew");
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
  it("is the canonical 7-element order with drivers after standing-crew and external below drivers", () => {
    expect(SESSION_TIER_ORDER).toEqual([
      "standing-crew",
      "drivers",
      "external",
      "cell-executor",
      "operator-chat-pane",
      "worker",
      "other",
    ]);
  });

  it("classifies a read-only external pane into the external tier, never `other`", () => {
    // Regression guard: external panes previously fell through the name/source
    // heuristics into `other`, which is default-collapsed, so none of them were
    // visible on load. This must classify before every other rule.
    const external = {
      ...mk("codex:done-cx-gap2", "/private/tmp/gap2-wt", 100),
      name: "done-cx-gap2",
      source: "codex",
      external: { runtime: "codex", tmuxSession: "done-cx-gap2", readOnly: true },
    } as unknown as Parameters<typeof classifyTier>[0];
    expect(classifyTier(external)).toBe("external");
  });
});

describe("groupTierByFolder", () => {
  it("nested mode (default) splits a tier's sessions by directory", () => {
    const a = mk("a", "/repoA", 100);
    const b = mk("b", "/repoB", 200);
    const groups = groupTierByFolder([a, b], true);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.cwd).sort()).toEqual(["/repoA", "/repoB"]);
  });

  it("flat mode collapses all sessions into one bucket with no directory sub-groups", () => {
    const a = mk("a", "/repoA", 100);
    const b = mk("b", "/repoB", 200);
    const groups = groupTierByFolder([a, b], false, undefined, "__tier__:drivers");
    expect(groups).toHaveLength(1);
    expect(groups[0]!.cwd).toBe("__tier__:drivers");
    expect(groups[0]!.sessions.map((session) => session.id).sort()).toEqual(["a", "b"]);
  });

  it("returns no buckets for empty input in either mode", () => {
    expect(groupTierByFolder([], false)).toHaveLength(0);
    expect(groupTierByFolder([], true)).toHaveLength(0);
  });
});
