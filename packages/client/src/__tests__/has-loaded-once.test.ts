import { describe, it, expect } from "vitest";
import { deriveHasLoadedOnce } from "../lib/has-loaded-once.js";

/**
 * The dual-source cold-load success oracle. ONE derived boolean, no FSM.
 * See change: build-2-dashboard-v3 (P0 fix #7).
 */
describe("deriveHasLoadedOnce", () => {
  it("false until BOTH sources settle successfully", () => {
    expect(deriveHasLoadedOnce({ restSessions: "pending", snapshotReceived: false, surfaces: "pending" })).toBe(false);
  });

  it("REST success + surfaces success → true (even with no snapshot)", () => {
    expect(deriveHasLoadedOnce({ restSessions: "success", snapshotReceived: false, surfaces: "success" })).toBe(true);
  });

  it("snapshot received + surfaces success → true (WS arm satisfies source 1)", () => {
    expect(deriveHasLoadedOnce({ restSessions: "pending", snapshotReceived: true, surfaces: "success" })).toBe(true);
  });

  it("a valid empty REST ([]) is success — loading ≠ empty", () => {
    // restSessions "success" is what the bootstrap reports for a valid [] body.
    expect(deriveHasLoadedOnce({ restSessions: "success", snapshotReceived: false, surfaces: "success" })).toBe(true);
  });

  it("REST failure alone keeps it false (never calm-zero on a failed source)", () => {
    expect(deriveHasLoadedOnce({ restSessions: "failure", snapshotReceived: false, surfaces: "success" })).toBe(false);
  });

  it("surfaces failure keeps it false even when sessions loaded", () => {
    expect(deriveHasLoadedOnce({ restSessions: "success", snapshotReceived: true, surfaces: "failure" })).toBe(false);
  });

  it("WS-degraded-but-REST-success still settles (snapshot never arrives)", () => {
    // WS offline → snapshotReceived false, but REST succeeded and surfaces
    // (an independent HTTP fetch) succeeded → the oracle settles true.
    expect(deriveHasLoadedOnce({ restSessions: "success", snapshotReceived: false, surfaces: "success" })).toBe(true);
  });

  it("surfaces pending keeps it false (both sources required)", () => {
    expect(deriveHasLoadedOnce({ restSessions: "success", snapshotReceived: true, surfaces: "pending" })).toBe(false);
  });
});
