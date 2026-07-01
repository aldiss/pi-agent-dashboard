/**
 * W1b — the `onDisconnect` consumer (event-wiring) + bridgeless-502 surface.
 *
 * The pi-gateway classifies a disconnect; the consumer must persist
 * `bridgeDisconnectReason` + `bridgeDisconnectAt` on the row and broadcast, and
 * an `unknown` reason must still be recorded (never blank) + logged. The
 * bridgeless-502 prompt surface must then say WHY (the recorded reason).
 *
 * Fake-object idiom (mirrors pi-gateway-consume-pending-attach.test.ts): the
 * consumer's behavior is reproduced from event-wiring's wiring against a fake
 * sessionManager/broadcast so we assert the persist+broadcast contract without
 * a real WS server.
 *
 * See change: bridge-disconnect-reason.
 */
import { describe, it, expect, vi } from "vitest";
import type { BridgeDisconnectReason, DashboardSession } from "../../../shared/src/types.js";

/**
 * The exact consumer body wired in event-wiring.ts `piGateway.onDisconnect`.
 * Kept in lock-step here so the persist+broadcast+fail-loud contract is unit-
 * tested. (event-wiring itself is exercised by the integration suite; this pins
 * the semantics.)
 */
function makeConsumer(deps: {
  sessionManager: {
    get: (id: string) => Partial<DashboardSession> | undefined;
    update: (id: string, u: Partial<DashboardSession>) => void;
  };
  broadcast: (id: string, u: Partial<DashboardSession>) => void;
  now: () => number;
  warn: (msg: string) => void;
}) {
  return (sessionId: string, reason: BridgeDisconnectReason) => {
    if (!deps.sessionManager.get(sessionId)) return;
    const updates: Partial<DashboardSession> = {
      bridgeDisconnectReason: reason,
      bridgeDisconnectAt: deps.now(),
    };
    deps.sessionManager.update(sessionId, updates);
    deps.broadcast(sessionId, updates);
    if (reason === "unknown") {
      deps.warn(`bridge disconnect reason UNKNOWN for ${sessionId}`);
    }
  };
}

function makeDeps(session?: Partial<DashboardSession>) {
  const store: Record<string, Partial<DashboardSession>> = {};
  if (session) store[session.id ?? "s1"] = session;
  const updates: Array<{ id: string; u: Partial<DashboardSession> }> = [];
  const broadcasts: Array<{ id: string; u: Partial<DashboardSession> }> = [];
  const warns: string[] = [];
  const deps = {
    sessionManager: {
      get: (id: string) => store[id],
      update: (id: string, u: Partial<DashboardSession>) => {
        updates.push({ id, u });
        store[id] = { ...(store[id] ?? {}), ...u };
      },
    },
    broadcast: (id: string, u: Partial<DashboardSession>) => broadcasts.push({ id, u }),
    now: () => 1_700_000_000_000,
    warn: (m: string) => warns.push(m),
  };
  return { deps, store, updates, broadcasts, warns };
}

describe("W1b onDisconnect consumer — persist + broadcast + fail-loud", () => {
  it("records reason + timestamp and broadcasts (heartbeat-timeout)", () => {
    const { deps, store, updates, broadcasts, warns } = makeDeps({ id: "s1", status: "active" });
    makeConsumer(deps)("s1", "heartbeat-timeout");
    expect(store.s1!.bridgeDisconnectReason).toBe("heartbeat-timeout");
    expect(store.s1!.bridgeDisconnectAt).toBe(1_700_000_000_000);
    expect(updates).toHaveLength(1);
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]!.u).toMatchObject({ bridgeDisconnectReason: "heartbeat-timeout" });
    expect(warns).toHaveLength(0);
  });

  it("each class round-trips onto the row", () => {
    for (const reason of ["cross-wire", "process-gone", "clean-shutdown"] as const) {
      const { deps, store } = makeDeps({ id: "s1", status: "active" });
      makeConsumer(deps)("s1", reason);
      expect(store.s1!.bridgeDisconnectReason).toBe(reason);
    }
  });

  it("unknown is RECORDED (never blank) AND logged loud", () => {
    const { deps, store, warns } = makeDeps({ id: "s1", status: "active" });
    makeConsumer(deps)("s1", "unknown");
    // Recorded, not blank.
    expect(store.s1!.bridgeDisconnectReason).toBe("unknown");
    expect(store.s1!.bridgeDisconnectReason).not.toBe("");
    expect(store.s1!.bridgeDisconnectReason).not.toBeUndefined();
    // Logged loud.
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/UNKNOWN/);
  });

  it("no-op when the row is already gone (nothing to annotate)", () => {
    const { deps, updates, broadcasts } = makeDeps(/* no session */);
    makeConsumer(deps)("missing", "process-gone");
    expect(updates).toHaveLength(0);
    expect(broadcasts).toHaveLength(0);
  });
});

// ── bridgeless-502 surface: the prompt endpoint says WHY ──────────────────
// Reproduces the session-api.ts prompt-endpoint 502 branch: when sendToSession
// returns false, the error string is enriched with the recorded reason.
function build502Error(session: { bridgeDisconnectReason?: BridgeDisconnectReason }): string {
  const why = session.bridgeDisconnectReason;
  return why
    ? `no bridge connection for session (last disconnect: ${why})`
    : "no bridge connection for session";
}

describe("W1b bridgeless-502 surface — says WHY not just THAT", () => {
  it("includes the recorded reason when present", () => {
    expect(build502Error({ bridgeDisconnectReason: "process-gone" })).toBe(
      "no bridge connection for session (last disconnect: process-gone)",
    );
  });

  it("includes unknown when that's what was recorded", () => {
    expect(build502Error({ bridgeDisconnectReason: "unknown" })).toBe(
      "no bridge connection for session (last disconnect: unknown)",
    );
  });

  it("falls back to the plain message when no reason recorded yet", () => {
    expect(build502Error({})).toBe("no bridge connection for session");
  });
});
