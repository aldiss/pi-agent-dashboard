/**
 * Component A — resurrection-sweep + shared `resurrectSession` tests.
 *
 * Proves the false-resurrection guard own-hand with an injected liveness
 * resolver (no real registry needed): alive→resurrect, dead-pid→stays-ended,
 * recycled-pid-no-UUID-match→stays-ended, CC-skipped, and the sweep candidate
 * filter (only endedAt-set pi/tmux rows are touched).
 */
import { describe, it, expect, vi } from "vitest";
import { createMemorySessionManager } from "../memory-session-manager.js";
import type { SessionManager } from "../memory-session-manager.js";
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import { resurrectSession, createResurrectionSweep, type LivenessResolver } from "../resurrection-sweep.js";

/** A browser-gateway stub capturing broadcastSessionUpdated calls. */
function stubGateway() {
  const calls: Array<{ id: string; updates: any }> = [];
  return {
    calls,
    broadcastSessionUpdated: (id: string, updates: any) => calls.push({ id, updates }),
  };
}

/** Seed an ENDED (tombstoned) tui session into a fresh manager. */
function seedEnded(mgr: SessionManager, id: string, overrides: Partial<DashboardSession> = {}) {
  mgr.restore({
    id,
    cwd: "/proj",
    source: "tui",
    status: "ended",
    startedAt: 1000,
    endedAt: 2000,
    pid: undefined,
    hidden: true,
    sessionFile: `/sessions/${id}.jsonl`,
    ...overrides,
  });
}

describe("resurrectSession (Component A shared helper)", () => {
  it("ALIVE: clears tombstone, rebinds pid, unhides, refreshes name, broadcasts", () => {
    const mgr = createMemorySessionManager();
    const gw = stubGateway();
    seedEnded(mgr, "s-alive");
    const resolveLiveness: LivenessResolver = () => ({ alive: true, name: "Don", pid: 4242 });

    const res = resurrectSession("s-alive", { sessionManager: mgr, browserGateway: gw, resolveLiveness });

    expect(res.resurrected).toBe(true);
    const s = mgr.get("s-alive")!;
    expect(s.status).toBe("idle");
    expect(s.endedAt).toBeUndefined();
    expect(s.hidden).toBe(false);
    expect(s.pid).toBe(4242);
    expect(s.name).toBe("Don");
    expect(gw.calls).toHaveLength(1);
    expect(gw.calls[0]).toMatchObject({ id: "s-alive", updates: { status: "idle", endedAt: undefined, hidden: false, pid: 4242, name: "Don" } });
  });

  it("DEAD pid: stays ended, no broadcast (false-resurrection guard)", () => {
    const mgr = createMemorySessionManager();
    const gw = stubGateway();
    seedEnded(mgr, "s-dead");
    const resolveLiveness: LivenessResolver = () => ({ alive: false });

    const res = resurrectSession("s-dead", { sessionManager: mgr, browserGateway: gw, resolveLiveness });

    expect(res.resurrected).toBe(false);
    const s = mgr.get("s-dead")!;
    expect(s.status).toBe("ended");
    expect(s.endedAt).toBe(2000);
    expect(gw.calls).toHaveLength(0);
  });

  it("recycled pid WITHOUT matching sessionId: resolver returns {alive:false} → stays ended", () => {
    // The real resolver's UUID-join returns {alive:false} for a recycled pid
    // that does not carry the queried sessionId. We model that exact contract.
    const mgr = createMemorySessionManager();
    const gw = stubGateway();
    seedEnded(mgr, "s-recycled");
    const resolveLiveness: LivenessResolver = (sid) => (sid === "the-live-one" ? { alive: true, pid: 9 } : { alive: false });

    const res = resurrectSession("s-recycled", { sessionManager: mgr, browserGateway: gw, resolveLiveness });

    expect(res.resurrected).toBe(false);
    expect(mgr.get("s-recycled")!.status).toBe("ended");
    expect(gw.calls).toHaveLength(0);
  });

  it("CC session: never resurrected even if resolver says alive", () => {
    const mgr = createMemorySessionManager();
    const gw = stubGateway();
    seedEnded(mgr, "s-cc", { source: "claude-code" });
    const resolveLiveness: LivenessResolver = () => ({ alive: true, pid: 1 });

    const res = resurrectSession("s-cc", { sessionManager: mgr, browserGateway: gw, resolveLiveness });

    expect(res.resurrected).toBe(false);
    expect(mgr.get("s-cc")!.status).toBe("ended");
    expect(gw.calls).toHaveLength(0);
  });

  it("unknown session id → {resurrected:false}, no throw", () => {
    const mgr = createMemorySessionManager();
    const gw = stubGateway();
    const res = resurrectSession("nope", { sessionManager: mgr, browserGateway: gw, resolveLiveness: () => ({ alive: true, pid: 1 }) });
    expect(res.resurrected).toBe(false);
  });

  it("livenessOverride: bypasses the registry resolver (Component B case-1 path)", () => {
    const mgr = createMemorySessionManager();
    const gw = stubGateway();
    seedEnded(mgr, "s-override");
    // resolver would say dead; override says alive (the bridge-connected proof).
    const resolveLiveness: LivenessResolver = () => ({ alive: false });

    const res = resurrectSession(
      "s-override",
      { sessionManager: mgr, browserGateway: gw, resolveLiveness },
      { alive: true, pid: 777 },
    );

    expect(res.resurrected).toBe(true);
    expect(mgr.get("s-override")!.pid).toBe(777);
    expect(mgr.get("s-override")!.status).toBe("idle");
  });
});

describe("createResurrectionSweep (Component A periodic pass)", () => {
  it("sweepOnce resurrects only ALIVE ended pi/tmux rows; leaves dead + CC + live rows untouched", () => {
    const mgr = createMemorySessionManager();
    const gw = stubGateway();
    seedEnded(mgr, "alive-1");
    seedEnded(mgr, "dead-1");
    seedEnded(mgr, "cc-1", { source: "claude-code" });
    // A LIVE (not-ended) row — must be skipped by the candidate filter (no kill-0 hammer).
    mgr.restore({ id: "live-1", cwd: "/proj", source: "tui", status: "idle", startedAt: 1, endedAt: undefined });

    const resolveLiveness: LivenessResolver = (sid) =>
      sid === "alive-1" ? { alive: true, name: "Lane", pid: 55 } : { alive: false };

    const sweep = createResurrectionSweep({ sessionManager: mgr, browserGateway: gw, resolveLiveness, intervalMs: 0 });
    const count = sweep.sweepOnce();

    expect(count).toBe(1);
    expect(mgr.get("alive-1")!.status).toBe("idle");
    expect(mgr.get("alive-1")!.pid).toBe(55);
    expect(mgr.get("dead-1")!.status).toBe("ended");
    expect(mgr.get("cc-1")!.status).toBe("ended");
    expect(mgr.get("live-1")!.status).toBe("idle"); // unchanged
    // Only alive-1 broadcast.
    expect(gw.calls.map((c) => c.id)).toEqual(["alive-1"]);
  });

  it("does NOT call the resolver for non-ended rows (filter gates before kill-0)", () => {
    const mgr = createMemorySessionManager();
    const gw = stubGateway();
    mgr.restore({ id: "live-only", cwd: "/proj", source: "tui", status: "active", startedAt: 1, endedAt: undefined });
    const resolveLiveness = vi.fn<LivenessResolver>(() => ({ alive: false }));

    const sweep = createResurrectionSweep({ sessionManager: mgr, browserGateway: gw, resolveLiveness, intervalMs: 0 });
    sweep.sweepOnce();

    expect(resolveLiveness).not.toHaveBeenCalled();
  });

  it("start() with intervalMs<=0 is a no-op (disabled); sweepOnce still callable", () => {
    const mgr = createMemorySessionManager();
    const gw = stubGateway();
    const sweep = createResurrectionSweep({ sessionManager: mgr, browserGateway: gw, resolveLiveness: () => ({ alive: false }), intervalMs: 0 });
    // Should not throw, should not schedule anything.
    sweep.start();
    sweep.stop();
    expect(sweep.sweepOnce()).toBe(0);
  });

  it("timer fires sweepOnce on the interval (fake timers)", () => {
    vi.useFakeTimers();
    try {
      const mgr = createMemorySessionManager();
      const gw = stubGateway();
      seedEnded(mgr, "alive-tick");
      let alive = false;
      const resolveLiveness: LivenessResolver = () => (alive ? { alive: true, pid: 1 } : { alive: false });
      const sweep = createResurrectionSweep({ sessionManager: mgr, browserGateway: gw, resolveLiveness, intervalMs: 20000 });
      sweep.start();

      // Before the tick: nothing.
      expect(mgr.get("alive-tick")!.status).toBe("ended");
      // Flip to alive, advance one interval → resurrected.
      alive = true;
      vi.advanceTimersByTime(20000);
      expect(mgr.get("alive-tick")!.status).toBe("idle");

      sweep.stop();
      // After stop, no further ticks fire.
      mgr.update("alive-tick", { status: "ended", endedAt: 3000 });
      vi.advanceTimersByTime(60000);
      expect(mgr.get("alive-tick")!.status).toBe("ended");
    } finally {
      vi.useRealTimers();
    }
  });
});
