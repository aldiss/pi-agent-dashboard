import { describe, it, expect } from "vitest";
import { createMemorySessionManager } from "../memory-session-manager.js";
import { reconcileSessionHygiene, type HygieneProbes } from "../session-hygiene.js";
import { projectSession } from "../session-projection.js";

/**
 * The FATAL the deep Sol-E2E caught (BUILD-2-E2E-dashboard-RECONCILE-33f4e37):
 * a bridge-connected PROVEN-LIVE session whose row still carried `endedAt` (from a
 * real unregister) was re-projected `status: "ended"` by projectSession and
 * collapsed behind "Show ended". The C9 UNIT fixture OMITTED endedAt, so the whole
 * non-sol gate + author-side + co-verify passed it green. This composes the REAL
 * row through manager -> reconcile-rescue -> projection -> JSON round-trip and
 * asserts the rescued-live row is NOT ended end-to-end (the fixture that should
 * have been). Goes-red on revert of the atomic endedAt-clear.
 */
describe("endedAt live-rescue convergence — the real-unregister FATAL guard", () => {
  function bridgeProbes(connectedIds: string[]): HygieneProbes {
    const set = new Set(connectedIds);
    return {
      isSessionConnected: (id) => set.has(id),
      resolveDriverLiveness: () => ({ alive: false }),
      pidAlive: () => false,
      listClaudePanes: () => [],
      claudePanesOk: () => true,
      listDriverTmuxSessions: () => [],
    };
  }

  it("a real unregister()'d row that reconnects bridge-connected is rescued live AND clears endedAt, so projection never re-kills it", () => {
    const mgr = createMemorySessionManager();
    mgr.register({ id: "s1", cwd: "/w", source: "tui" });
    // Real unregister: status=ended + endedAt stamped (the shape the C9 fixture omitted).
    mgr.unregister("s1");
    const dead = mgr.get("s1")!;
    expect(dead.status).toBe("ended");
    expect(typeof dead.endedAt).toBe("number"); // a real endedAt tombstone

    // The :9999 bridge reconnects -> verifySessionLive is bridge-first live (FIX-A).
    const probes = bridgeProbes(["s1"]);
    const actions = reconcileSessionHygiene(mgr.listAll(), probes, { nowMs: Date.now() });
    for (const a of actions) mgr.update(a.sessionId, a.updates);

    const rescued = mgr.get("s1")!;
    expect(rescued.status).toBe("idle"); // rescued live
    expect(rescued.endedAt).toBeNull(); // ATOMIC: endedAt cleared to null, not left stale

    // Projection (REST/WS) must NOT re-kill the rescued-live row.
    const projected = projectSession(rescued, (id) => probes.isSessionConnected(id));
    expect(projected.status).toBe("idle"); // NOT re-normalized to ended
    expect(projected.bridgeConnected).toBe(true);

    // JSON round-trip (the wire): null must survive so the client clears its tombstone.
    const wire = JSON.parse(JSON.stringify(projected)) as typeof projected;
    expect(wire.status).toBe("idle");
    expect(wire.endedAt).toBeNull(); // null survives (undefined would have been dropped)
    expect(wire.bridgeConnected).toBe(true);
  });

  it("control: a genuinely-ended row (endedAt set, NOT bridge-connected) still projects ended", () => {
    const mgr = createMemorySessionManager();
    mgr.register({ id: "s2", cwd: "/w", source: "tui" });
    mgr.unregister("s2");
    // No bridge connection -> not rescued -> stays ended -> projection keeps ended.
    const probes = bridgeProbes([]); // s2 NOT connected
    const actions = reconcileSessionHygiene(mgr.listAll(), probes, { nowMs: Date.now() });
    for (const a of actions) mgr.update(a.sessionId, a.updates);
    const projected = projectSession(mgr.get("s2")!, (id) => probes.isSessionConnected(id));
    expect(projected.status).toBe("ended"); // genuinely ended stays ended
  });
});
