/**
 * Session-row hygiene tests (dashboard-session-row-hygiene — LOCKED dl-3397).
 *
 * Proves the LOCKED shape + Joan's 5 invariants own-hand against in-memory
 * fixtures (no real registry / tmux — all I/O injected via HygieneProbes):
 *
 *   F1  dead-no-pid → retired (hidden-not-deleted).
 *   F1  live-no-bridge → NOT retired (★ the no-regress guard, dl-2929 false-end).
 *   F2  registry clean-name applied on the read-path (∅ / prompt-text killed).
 *   F4  CC-pane-alive → live + clean cc-launch name (NEVER prompt-text).
 *   ★   retire on a LIVE pid → REFUSED + anomaly (Joan invariant #1+#4).
 *   ★   multi-key resolution (sessionId | tmuxName | pid resolve same session).
 *   inv idempotent: a second reconcile pass is a no-op.
 */
import { describe, it, expect } from "vitest";
import {
  verifySessionLive,
  reconcileSessionHygiene,
  resolveRetireTargets,
  evaluateRetire,
  type HygieneProbes,
  type HygieneSession,
} from "../session-hygiene.js";
import type { ClaudePane } from "../cc-pane-liveness.js";

const ALIVE = 4242;
const DEAD = 2147483646;

/** Build injected probes from explicit fixtures — every test is hermetic. */
function makeProbes(opts: {
  /** sessionIds with a live registry kill-0 bind, → clean name. */
  registryLive?: Record<string, string>;
  /** pids that kill-0 alive. */
  alivePids?: number[];
  /** live `claude` tmux panes. */
  panes?: ClaudePane[];
}): HygieneProbes {
  const registryLive = opts.registryLive ?? {};
  const alivePids = new Set(opts.alivePids ?? []);
  const panes = opts.panes ?? [];
  return {
    resolveDriverLiveness: (sessionId: string) =>
      registryLive[sessionId]
        ? { alive: true, name: registryLive[sessionId] }
        : { alive: false },
    pidAlive: (pid: number) => alivePids.has(pid),
    listClaudePanes: () => panes,
  };
}

function s(partial: Partial<HygieneSession> & Pick<HygieneSession, "id">): HygieneSession {
  return {
    cwd: "/work/x",
    source: "tmux",
    status: "ended",
    startedAt: 1_000,
    ...partial,
  };
}

describe("verifySessionLive — the explicit liveness predicate (invariant #4)", () => {
  it("non-CC: registry kill-0 bind → live + clean name", () => {
    const probes = makeProbes({ registryLive: { d1: "Don" } });
    expect(verifySessionLive(s({ id: "d1", name: "∅" }), probes)).toMatchObject({
      live: true,
      reason: "registry-kill0",
      cleanName: "Don",
    });
  });

  it("non-CC: no registry bind, but record pid kill-0 alive → live (cross-fork guard)", () => {
    const probes = makeProbes({ alivePids: [ALIVE] });
    expect(verifySessionLive(s({ id: "x", pid: ALIVE }), probes)).toMatchObject({
      live: true,
      reason: "pid-kill0",
    });
  });

  it("non-CC: no bind + dead pid → not live", () => {
    const probes = makeProbes({});
    expect(verifySessionLive(s({ id: "x", pid: DEAD }), probes)).toEqual({
      live: false,
      reason: "no-live-bind",
    });
  });

  it("CC: a live claude pane in the session cwd → live + tmux session-name (NEVER prompt-text)", () => {
    const probes = makeProbes({
      panes: [{ sessionName: "cc-row-hygiene-build", cwd: "/work/cc", pid: ALIVE }],
    });
    const out = verifySessionLive(
      s({ id: "cc1", source: "claude-code", cwd: "/work/cc", name: "You are composing a FRESH status deck…" }),
      probes,
    );
    expect(out).toMatchObject({ live: true, reason: "cc-pane-alive", cleanName: "cc-row-hygiene-build", pid: ALIVE });
  });

  it("CC: no live pane in cwd → not live (correctly ended read-only view)", () => {
    const probes = makeProbes({ panes: [{ sessionName: "cc-other", cwd: "/work/other", pid: ALIVE }] });
    expect(verifySessionLive(s({ id: "cc2", source: "claude-code", cwd: "/work/cc" }), probes)).toEqual({
      live: false,
      reason: "cc-no-pane",
    });
  });
});

describe("F1 ghost-reap on the read-path", () => {
  it("dead-no-pid ended session → retired (hidden:true)", () => {
    const probes = makeProbes({});
    const actions = reconcileSessionHygiene([s({ id: "ghost", status: "ended" })], probes, { nowMs: 9_999 });
    expect(actions).toEqual([
      { sessionId: "ghost", updates: { hidden: true }, reason: "reap:no-live-bind" },
    ]);
  });

  it("★ live-no-bridge → NOT retired (the no-regress guard / dl-2929 false-ended fixture)", () => {
    // A live driver whose bridge dropped: status got false-set to ended, but its
    // pid is kill-0 ALIVE. F1 must NOT reap it — instead rescue it to idle+visible.
    const probes = makeProbes({ alivePids: [ALIVE] });
    const actions = reconcileSessionHygiene(
      [s({ id: "live", status: "ended", hidden: true, pid: ALIVE })],
      probes,
      { nowMs: 9_999 },
    );
    // Rescued, never reaped.
    expect(actions).toHaveLength(1);
    expect(actions[0].sessionId).toBe("live");
    expect(actions[0].updates).toMatchObject({ status: "idle", hidden: false });
    expect(actions[0].reason).toMatch(/^live:/);
  });

  it("a live registry-bound driver that is correctly visible → no action (idempotent)", () => {
    const probes = makeProbes({ registryLive: { don: "Don" } });
    const actions = reconcileSessionHygiene(
      [s({ id: "don", name: "Don", status: "idle", hidden: false })],
      probes,
      { nowMs: 9_999 },
    );
    expect(actions).toEqual([]);
  });

  it("an already-hidden dead ghost → no action (idempotent, not re-hidden)", () => {
    const probes = makeProbes({});
    const actions = reconcileSessionHygiene(
      [s({ id: "g", status: "ended", hidden: true })],
      probes,
      { nowMs: 9_999 },
    );
    expect(actions).toEqual([]);
  });

  it("grace window: a just-ended dead row within grace is NOT yet reaped", () => {
    const probes = makeProbes({});
    const now = 100_000;
    const actions = reconcileSessionHygiene(
      [s({ id: "fresh", status: "ended", endedAt: now - 1_000 })],
      probes,
      { nowMs: now, graceMs: 60_000 },
    );
    expect(actions).toEqual([]); // within 60s grace
  });

  it("grace window: a long-dead row past grace IS reaped", () => {
    const probes = makeProbes({});
    const now = 100_000;
    const actions = reconcileSessionHygiene(
      [s({ id: "old", status: "ended", endedAt: now - 120_000 })],
      probes,
      { nowMs: now, graceMs: 60_000 },
    );
    expect(actions).toEqual([{ sessionId: "old", updates: { hidden: true }, reason: "reap:no-live-bind" }]);
  });

  it("a resuming session is never reaped even if verified-dead-looking", () => {
    const probes = makeProbes({});
    const actions = reconcileSessionHygiene(
      [s({ id: "r", status: "ended", resuming: true })],
      probes,
      { nowMs: 9_999 },
    );
    expect(actions).toEqual([]);
  });
});

describe("F2 name-canonicalization on the read-path", () => {
  it("a live driver with a ∅ / stale label gets the registry clean name", () => {
    const probes = makeProbes({ registryLive: { j: "Joan" } });
    const actions = reconcileSessionHygiene(
      [s({ id: "j", name: "∅", status: "idle", hidden: false })],
      probes,
      { nowMs: 1 },
    );
    expect(actions).toEqual([{ sessionId: "j", updates: { name: "Joan" }, reason: "live:registry-kill0" }]);
  });

  it("no rename when the label already equals the canonical name (idempotent)", () => {
    const probes = makeProbes({ registryLive: { j: "Joan" } });
    const actions = reconcileSessionHygiene(
      [s({ id: "j", name: "Joan", status: "idle", hidden: false })],
      probes,
      { nowMs: 1 },
    );
    expect(actions).toEqual([]);
  });
});

describe("F4 CC visibility — prompt-text label replaced by cc-launch tmux name", () => {
  it("a false-ended CC pane is rescued to idle+visible and renamed from the pane", () => {
    const probes = makeProbes({
      panes: [{ sessionName: "cc-composer-build", cwd: "/work/cc", pid: ALIVE }],
    });
    const actions = reconcileSessionHygiene(
      [s({ id: "cc", source: "claude-code", cwd: "/work/cc", name: "Ты Bert CC…", status: "ended", hidden: true })],
      probes,
      { nowMs: 1 },
    );
    expect(actions).toHaveLength(1);
    expect(actions[0].updates).toMatchObject({ name: "cc-composer-build", status: "idle", hidden: false, pid: ALIVE });
  });

  it("two CC sessions sharing a cwd with ONE live pane: BOTH read live (never hide a live row)", () => {
    // Conservative: a live pane in the cwd means we cannot prove EITHER dead,
    // so neither is reaped — invariant #1 over dedup-prettiness.
    const probes = makeProbes({ panes: [{ sessionName: "cc-x", cwd: "/work/cc", pid: ALIVE }] });
    const sessions = [
      s({ id: "cc-new", source: "claude-code", cwd: "/work/cc", status: "ended", startedAt: 2_000 }),
      s({ id: "cc-old", source: "claude-code", cwd: "/work/cc", status: "ended", startedAt: 1_000 }),
    ];
    const actions = reconcileSessionHygiene(sessions, probes, { nowMs: 9_999 });
    // Neither is reaped (no `reap:` action).
    expect(actions.every((a) => !a.reason.startsWith("reap:"))).toBe(true);
  });
});

describe("retire endpoint — multi-key resolution", () => {
  const sessions = [s({ id: "uuid-1", name: "AutoHandoffDriver", pid: 5151, cwd: "/w" })];

  it("sessionId resolves the record", () => {
    expect(resolveRetireTargets(sessions, { sessionId: "uuid-1" }).map((t) => t.id)).toEqual(["uuid-1"]);
  });
  it("tmuxName resolves the same record", () => {
    expect(resolveRetireTargets(sessions, { tmuxName: "AutoHandoffDriver" }).map((t) => t.id)).toEqual(["uuid-1"]);
  });
  it("pid resolves the same record", () => {
    expect(resolveRetireTargets(sessions, { pid: 5151 }).map((t) => t.id)).toEqual(["uuid-1"]);
  });
  it("a miss resolves nothing", () => {
    expect(resolveRetireTargets(sessions, { tmuxName: "Nope" })).toEqual([]);
  });
});

describe("★ retire endpoint — verify-dead guard (Joan invariant #1 + #4) ★", () => {
  it("retire on a confirmed-DEAD ghost → retired", () => {
    const probes = makeProbes({});
    const d = evaluateRetire([s({ id: "dead", name: "Joan", status: "ended" })], { tmuxName: "Joan" }, probes);
    expect(d).toMatchObject({ retired: ["dead"], refusedLive: [], anomaly: false });
  });

  it("★ retire on a LIVE pid → REFUSED + anomaly (never hide a live row)", () => {
    const probes = makeProbes({ alivePids: [ALIVE] });
    const d = evaluateRetire([s({ id: "live", name: "Joan", pid: ALIVE, status: "idle" })], { pid: ALIVE }, probes);
    expect(d.retired).toEqual([]);
    expect(d.anomaly).toBe(true);
    expect(d.refusedLive[0]).toMatchObject({ sessionId: "live", reason: "pid-kill0" });
  });

  it("★ retire on a LIVE registry-bound driver → REFUSED + anomaly", () => {
    const probes = makeProbes({ registryLive: { live: "Faye" } });
    const d = evaluateRetire([s({ id: "live", name: "Faye", status: "idle" })], { sessionId: "live" }, probes);
    expect(d.anomaly).toBe(true);
    expect(d.retired).toEqual([]);
  });

  it("★ retire on a LIVE CC pane (by tmuxName) → REFUSED + anomaly", () => {
    const probes = makeProbes({ panes: [{ sessionName: "cc-live", cwd: "/work/cc", pid: ALIVE }] });
    const d = evaluateRetire(
      [s({ id: "cc", source: "claude-code", cwd: "/work/cc", name: "cc-live", status: "ended" })],
      { tmuxName: "cc-live" },
      probes,
    );
    expect(d.anomaly).toBe(true);
    expect(d.retired).toEqual([]);
  });

  it("cross-fork ×N: among duplicate-name rows, the DEAD ones retire while a LIVE one does NOT", () => {
    // The dl-2939 incident shape: a tmuxName matching both a dead ghost and a
    // live cross-wired row. Only the dead one may retire.
    const probes = makeProbes({ alivePids: [ALIVE] });
    const sessions = [
      s({ id: "joan-dead", name: "Joan", status: "ended", pid: DEAD }),
      s({ id: "joan-live", name: "Joan", status: "idle", pid: ALIVE }),
    ];
    const d = evaluateRetire(sessions, { tmuxName: "Joan" }, probes);
    expect(d.retired).toEqual(["joan-dead"]);
    expect(d.refusedLive.map((r) => r.sessionId)).toEqual(["joan-live"]);
    expect(d.anomaly).toBe(true);
  });

  it("no record matches AND key proves nothing live → benign notFound (F1 backstop covers it)", () => {
    const probes = makeProbes({});
    const d = evaluateRetire([s({ id: "x", name: "A" })], { tmuxName: "ghost-gone" }, probes);
    expect(d).toMatchObject({ retired: [], notFound: true, anomaly: false });
  });

  it("no record matches BUT pid is kill-0 alive → anomaly (a live thing exists untracked)", () => {
    const probes = makeProbes({ alivePids: [ALIVE] });
    const d = evaluateRetire([s({ id: "x", name: "A" })], { pid: ALIVE }, probes);
    expect(d.anomaly).toBe(true);
    expect(d.retired).toEqual([]);
  });
});
