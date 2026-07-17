import { describe, it, expect } from "vitest";
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import { stablePartitionByBand } from "../lib/session-grouping.js";

/**
 * Stable-partition of the persisted-order id base so band-1 (needs-you) rises
 * to the top of the ALIVE zone without a second lane. See change:
 * build-2-dashboard-v3 (P0 fix #10 + #3).
 */

function mk(id: string, overrides: Partial<DashboardSession> = {}): DashboardSession {
  return {
    id,
    cwd: "/tmp",
    source: "tui",
    status: "idle",
    startedAt: 1,
    tokensIn: 0,
    tokensOut: 0,
    cost: 0,
    ...overrides,
  } as DashboardSession;
}

function mapOf(...sessions: DashboardSession[]): Map<string, DashboardSession> {
  return new Map(sessions.map((s) => [s.id, s]));
}

describe("stablePartitionByBand", () => {
  it("lifts an unseenServerError session above calm alive sessions, preserving order otherwise", () => {
    const sessions = [
      mk("a"),
      mk("b", { unseenServerError: true }),
      mk("c"),
    ];
    const ids = ["a", "b", "c"];
    expect(stablePartitionByBand(ids, mapOf(...sessions))).toEqual(["b", "a", "c"]);
  });

  it("lifts an ask_user session into the needs band", () => {
    const sessions = [mk("a"), mk("b"), mk("c", { currentTool: "ask_user" })];
    expect(stablePartitionByBand(["a", "b", "c"], mapOf(...sessions))).toEqual(["c", "a", "b"]);
  });

  it("keeps ended sessions at the tail — a corpse never rises even with unseenServerError", () => {
    const sessions = [
      mk("alive"),
      mk("deadError", { status: "ended", endedAt: 9, unseenServerError: true }),
      mk("needs", { currentTool: "ask_user" }),
    ];
    // needs rises to top; ended (even errored) stays at tail; calm alive middle.
    expect(stablePartitionByBand(["alive", "deadError", "needs"], mapOf(...sessions)))
      .toEqual(["needs", "alive", "deadError"]);
  });

  it("preserves relative order within each of the three bands (stable)", () => {
    const sessions = [
      mk("n1", { unseenServerError: true }),
      mk("c1"),
      mk("n2", { currentTool: "ask_user" }),
      mk("c2"),
      mk("e1", { status: "ended", endedAt: 5 }),
      mk("e2", { status: "ended", endedAt: 6 }),
    ];
    const ids = ["n1", "c1", "n2", "c2", "e1", "e2"];
    // needs [n1,n2] preserve order; calm [c1,c2]; ended [e1,e2].
    expect(stablePartitionByBand(ids, mapOf(...sessions))).toEqual(["n1", "n2", "c1", "c2", "e1", "e2"]);
  });

  it("is a no-op when nothing needs the operator", () => {
    const sessions = [mk("a"), mk("b"), mk("c", { status: "ended", endedAt: 3 })];
    expect(stablePartitionByBand(["a", "b", "c"], mapOf(...sessions))).toEqual(["a", "b", "c"]);
  });

  it("keeps unknown ids (no session) in the calm band defensively", () => {
    const sessions = [mk("known", { unseenServerError: true })];
    expect(stablePartitionByBand(["ghost", "known"], mapOf(...sessions))).toEqual(["known", "ghost"]);
  });
});
