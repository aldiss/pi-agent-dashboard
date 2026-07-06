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
  /** live tmux SESSION names (the pi-driver 3rd liveness axis). */
  tmuxSessions?: string[];
}): HygieneProbes {
  const registryLive = opts.registryLive ?? {};
  const alivePids = new Set(opts.alivePids ?? []);
  const panes = opts.panes ?? [];
  const tmuxSessions = opts.tmuxSessions ?? [];
  return {
    resolveDriverLiveness: (sessionId: string) =>
      registryLive[sessionId]
        ? { alive: true, name: registryLive[sessionId] }
        : { alive: false },
    pidAlive: (pid: number) => alivePids.has(pid),
    listClaudePanes: () => panes,
    listDriverTmuxSessions: () => tmuxSessions,
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

describe("§22 de-ghost — demote frozen non-ended ghosts (SHIP-1)", () => {
  it("★ a frozen-IDLE verified-dead ghost → DEMOTED to ended+hidden (the §22 missing piece)", () => {
    // Reconcile's reap only fired on status==='ended'; a frozen-"idle" ghost
    // (REG-absent ∧ dead) — Ferris2/4/Weaver3 — fell through. Now DEMOTED.
    const probes = makeProbes({});
    const now = 500_000;
    const actions = reconcileSessionHygiene([s({ id: "ferris2", status: "idle" })], probes, { nowMs: now });
    expect(actions).toEqual([
      { sessionId: "ferris2", updates: { status: "ended", endedAt: now, hidden: true }, reason: "demote:no-live-bind" },
    ]);
  });

  it("★ Alice-safety negative arm: a REG-absent frozen-idle row whose record-pid is kill-0 ALIVE → NOT demoted", () => {
    // REG-absent is the candidate SIGNAL, kill-0-dead is the TRIGGER. A live-but-
    // unregistered row is kept via the pid-kill0 backstop — never demoted (Alice §4).
    const probes = makeProbes({ alivePids: [ALIVE] });
    const actions = reconcileSessionHygiene(
      [s({ id: "alice", status: "idle", hidden: false, pid: ALIVE })],
      probes,
      { nowMs: 500_000 },
    );
    expect(actions).toEqual([]);
  });

  it("post-restart grace (envelope #3): withinPostRestartGrace → ZERO actions even for a dead idle ghost", () => {
    const probes = makeProbes({});
    const actions = reconcileSessionHygiene(
      [s({ id: "ghost", status: "idle" })],
      probes,
      { nowMs: 500_000, withinPostRestartGrace: true },
    );
    expect(actions).toEqual([]);
  });

  it("★ never-respawn (Alice #3): all-bridges-absent → only demote/reap, NEVER a respawn/resurrect", () => {
    const probes = makeProbes({}); // every registry bind gone = all bridges absent
    const actions = reconcileSessionHygiene(
      [s({ id: "idle-ghost", status: "idle" }), s({ id: "ended-ghost", status: "ended" })],
      probes,
      { nowMs: 500_000 },
    );
    for (const a of actions) {
      expect(a.reason).toMatch(/^(demote|reap):/);
      expect(a.updates.status ?? "ended").toBe("ended"); // never resurrected to idle/active
      expect(a.updates.hidden).toBe(true);
    }
    expect(actions.map((a) => a.sessionId).sort()).toEqual(["ended-ghost", "idle-ghost"]);
  });

  it("a resuming frozen-idle row is NEVER demoted (resuming guard)", () => {
    const probes = makeProbes({});
    const actions = reconcileSessionHygiene(
      [s({ id: "res", status: "idle", resuming: true })],
      probes,
      { nowMs: 500_000 },
    );
    expect(actions).toEqual([]);
  });

  it("★ live-but-unregistered tmux pi-driver (REG-absent, pid=none) → KEPT via tmux-session-alive (the false-demote fix)", () => {
    // SwiftPilot/Keystone class: REG-absent, NULL row-pid, but a live tmux session
    // named after the driver. The 3rd liveness axis keeps it — NEVER demoted.
    const probes = makeProbes({ tmuxSessions: ["SwiftPilot", "Keystone"] });
    const actions = reconcileSessionHygiene(
      [s({ id: "sp", name: "SwiftPilot", status: "idle" })],
      probes,
      { nowMs: 500_000 },
    );
    expect(actions).toEqual([]); // kept alive via tmux-session, not demoted
  });

  it("★ exact-name match: a superseded lineage row ('Conductor') is NOT kept by a 'Conductor-2' session → correctly demoted", () => {
    // Joan's lineage-collapse: old-Conductor's row must NOT false-KEEP off the
    // live Conductor-2 session. EXACT session-name match ('Conductor' ∉ ['Conductor-2']).
    const probes = makeProbes({ tmuxSessions: ["Conductor-2"] });
    const actions = reconcileSessionHygiene(
      [s({ id: "cond", name: "Conductor", status: "idle" })],
      probes,
      { nowMs: 500_000 },
    );
    expect(actions).toEqual([
      { sessionId: "cond", updates: { status: "ended", endedAt: 500_000, hidden: true }, reason: "demote:no-live-bind" },
    ]);
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

describe("tmux name-token over-keep disambiguation (the 9-Alice regression, dl-4971 follow-up)", () => {
  it("1 live-pid record + N same-name null-pid ghosts + 1 unique live tmux → keeps the live, DEMOTES the ghosts", () => {
    // The prod regression: 1 live Alice (pid kill-0 alive) + 3 dead Alice ghosts
    // (null pid, idle, aged) all share nameToken "Alice" and the ONE live tmux
    // "Alice" kept all 4 via the weak tmux name-axis. The live one is held by the
    // STRONG pid-kill0 axis, so the ghosts must collapse.
    const probes = makeProbes({ alivePids: [ALIVE], tmuxSessions: ["Alice"] });
    const sessions = [
      s({ id: "alice-live", name: "Alice", status: "active", pid: ALIVE, lastActivityAt: 1_000 }),
      s({ id: "ghost-1", name: "Alice", status: "idle", lastActivityAt: 1_000 }),
      s({ id: "ghost-2", name: "Alice", status: "idle", lastActivityAt: 1_000 }),
      s({ id: "ghost-3", name: "Alice", status: "idle", lastActivityAt: 1_000 }),
    ];
    const actions = reconcileSessionHygiene(sessions, probes, { nowMs: 200_000 });
    // The live Alice is NEVER hidden (invariant #1 — held via pid-kill0).
    expect(actions.find((a) => a.sessionId === "alice-live" && a.updates.hidden === true)).toBeUndefined();
    // All 3 ghosts demoted to ended+hidden with the superseded reason.
    for (const id of ["ghost-1", "ghost-2", "ghost-3"]) {
      const act = actions.find((a) => a.sessionId === id);
      expect(act?.updates).toMatchObject({ status: "ended", hidden: true });
      expect(act?.reason).toBe("demote:tmux-name-superseded");
    }
  });

  it("false-demote-safe: a SINGLE null-pid tmux-live driver with NO strong same-name sibling STAYS live", () => {
    // The legit case the 3rd axis exists for: a live-but-unregistered pi-driver,
    // null row-pid, running in its own tmux — no strong same-name sibling claims
    // the name, so it keeps its tmux-axis liveness (never false-demoted).
    const probes = makeProbes({ tmuxSessions: ["Solo"] });
    const actions = reconcileSessionHygiene(
      [s({ id: "solo", name: "Solo", status: "idle", lastActivityAt: 1_000 })],
      probes,
      { nowMs: 9_999 },
    );
    expect(actions.find((a) => a.sessionId === "solo" && a.updates.hidden === true)).toBeUndefined();
  });

  it("a registry-live sibling supersedes same-name ghosts even with a STALE row label (uses clean mesh-name)", () => {
    // The strong-live row's label is stale (∅); its registry clean-name "Bob" is
    // the tmux/mesh name the ghost matched — so the supersede keys off cleanName.
    const probes = makeProbes({ registryLive: { "bob-live": "Bob" }, tmuxSessions: ["Bob"] });
    const sessions = [
      s({ id: "bob-live", name: "∅", status: "active", lastActivityAt: 1_000 }),
      s({ id: "bob-ghost", name: "Bob", status: "idle", lastActivityAt: 1_000 }),
    ];
    const actions = reconcileSessionHygiene(sessions, probes, { nowMs: 200_000 });
    const ghost = actions.find((a) => a.sessionId === "bob-ghost");
    expect(ghost?.updates).toMatchObject({ status: "ended", hidden: true });
    expect(ghost?.reason).toBe("demote:tmux-name-superseded");
    // The live Bob is NOT hidden (it gets an F2 name-canon action instead).
    expect(actions.find((a) => a.sessionId === "bob-live" && a.updates.hidden === true)).toBeUndefined();
  });

  it("perf: listDriverTmuxSessions is snapshotted ONCE per reconcile pass, not per-record", () => {
    // The ~27s /api/sessions latency: the uncached tmux probe re-shelled per
    // record over ~500 rows. The pass now snapshots it once.
    let tmuxCalls = 0;
    const base = makeProbes({ tmuxSessions: ["X"] });
    const probes: HygieneProbes = {
      ...base,
      listDriverTmuxSessions: () => { tmuxCalls++; return ["X"]; },
    };
    const sessions = Array.from({ length: 50 }, (_, i) =>
      s({ id: `r${i}`, name: `Ghost${i}`, status: "idle", lastActivityAt: 1_000 }),
    );
    reconcileSessionHygiene(sessions, probes, { nowMs: 9_999 });
    expect(tmuxCalls).toBe(1);
  });

  it("grace belt: a RECENTLY-active superseded row is NOT immediately demoted under graceMs:0 (invariant #1 residual)", () => {
    // The degenerate anomaly the belt guards: even though the prod sweep passes
    // graceMs:0 (agedOut no-op), a superseded verdict is heuristic, so a recently-
    // active would-be-ghost gets the SUPERSEDED_DEMOTE_MIN_GRACE_MS window and is
    // never immediately hidden.
    const probes = makeProbes({ alivePids: [ALIVE], tmuxSessions: ["Twin"] });
    const nowMs = 500_000;
    const recent = [
      s({ id: "twin-strong", name: "Twin", status: "active", pid: ALIVE, lastActivityAt: nowMs - 1_000 }),
      s({ id: "twin-recent", name: "Twin", status: "idle", lastActivityAt: nowMs - 1_000 }),
    ];
    const a1 = reconcileSessionHygiene(recent, probes, { nowMs, graceMs: 0 });
    expect(a1.find((a) => a.sessionId === "twin-recent" && a.updates.hidden === true)).toBeUndefined();

    // But an OLD superseded sibling (past the belt) IS demoted — real ghosts still collapse.
    const old = [
      s({ id: "twin-strong", name: "Twin", status: "active", pid: ALIVE, lastActivityAt: nowMs - 1_000 }),
      s({ id: "twin-old", name: "Twin", status: "idle", lastActivityAt: nowMs - 300_000 }),
    ];
    const a2 = reconcileSessionHygiene(old, probes, { nowMs, graceMs: 0 });
    const oldAct = a2.find((a) => a.sessionId === "twin-old");
    expect(oldAct?.updates).toMatchObject({ status: "ended", hidden: true });
    expect(oldAct?.reason).toBe("demote:tmux-name-superseded");
  });
});
