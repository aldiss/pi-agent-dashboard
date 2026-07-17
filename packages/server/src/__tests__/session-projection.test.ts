import { describe, it, expect } from "vitest";
import { projectSession } from "../session-projection.js";
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";

function sess(p: Partial<DashboardSession> & Pick<DashboardSession, "id">): DashboardSession {
  return { cwd: "/w", source: "tui", status: "idle", startedAt: 1000, ...p } as DashboardSession;
}

describe("projectSession — bridgeConnected + endedAt-norm (FIX-C2/C3)", () => {
  it("C2: annotates bridgeConnected from the oracle (connected -> true, disconnected -> false)", () => {
    const connected = new Set(["live"]);
    const isConnected = (id: string) => connected.has(id);
    expect(projectSession(sess({ id: "live" }), isConnected).bridgeConnected).toBe(true);
    expect(projectSession(sess({ id: "gone" }), isConnected).bridgeConnected).toBe(false);
  });

  it("C3: endedAt set -> status normalized to ended (live-snapshot twin of cold-restore)", () => {
    const p = projectSession(sess({ id: "x", status: "idle", endedAt: 1784279971285 }), () => false);
    expect(p.status).toBe("ended");
    expect(p.endedAt).toBe(1784279971285);
  });

  it("C3 control: no endedAt -> status untouched", () => {
    const p = projectSession(sess({ id: "x", status: "idle" }), () => false);
    expect(p.status).toBe("idle");
  });

  it("annotate-only: preserves every other field, only adds bridgeConnected + status-norm", () => {
    const original = sess({ id: "x", name: "Keep", cost: 5, tokensIn: 10 });
    const p = projectSession(original, () => true);
    expect(p.name).toBe("Keep");
    expect(p.cost).toBe(5);
    expect(p.tokensIn).toBe(10);
    expect(p.id).toBe("x");
    expect(p.bridgeConnected).toBe(true);
  });
});
