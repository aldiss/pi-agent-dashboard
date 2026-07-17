import { describe, expect, it } from "vitest";
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import { createCellRegistrySnapshot, resolveSessionAccessCell } from "../cell-access.js";

function session(id: string, extra: Partial<DashboardSession> = {}): DashboardSession {
  return { id, name: id, cwd: "/repo", source: "tmux", status: "active", startedAt: 1, ...extra };
}

// M3 — one-sided missing PID must NOT corroborate a reused driver name.
describe("cell access — positive PID corroboration required for name match", () => {
  it("a same-name messenger with NO pid does not resolve to a pid-bearing driver's cell", () => {
    const snapshot = createCellRegistrySnapshot(
      { drivers: { Reused: { real_name: "Reused", cell: "cell-a", pid: 222, session_log: "" } } },
      // Messenger shares the driver name + binds the session, but carries no pid.
      [{ name: "Reused", sessionId: "sid-reused" }],
    );
    // Reused-name → cross-cell access: without a corroborating pid, a name-only
    // hit must be rejected (not granted cell-a).
    expect(resolveSessionAccessCell(session("sid-reused"), snapshot)).toBeUndefined();
  });

  it("preserves a legitimate match when both pids are present and agree", () => {
    const snapshot = createCellRegistrySnapshot(
      { drivers: { Reused: { real_name: "Reused", cell: "cell-a", pid: 222, session_log: "" } } },
      [{ name: "Reused", sessionId: "sid-reused", pid: 222 }],
    );
    expect(resolveSessionAccessCell(session("sid-reused"), snapshot)).toBe("cell-a");
  });

  it("rejects a same-name messenger whose pid disagrees with the driver", () => {
    const snapshot = createCellRegistrySnapshot(
      { drivers: { Reused: { real_name: "Reused", cell: "cell-a", pid: 222, session_log: "" } } },
      [{ name: "Reused", sessionId: "sid-reused", pid: 999 }],
    );
    expect(resolveSessionAccessCell(session("sid-reused"), snapshot)).toBeUndefined();
  });
});
