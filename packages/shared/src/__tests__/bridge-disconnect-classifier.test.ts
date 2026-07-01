/**
 * W1b — bridge-disconnect-reason classifier (ROOT-CAUSE Gap #4).
 *
 * Every disconnect class must map deterministically to its first-class reason,
 * and an undeterminable cause must record `unknown` — NEVER blank (fail-loud).
 * Precedence: cross-wire > clean-shutdown > heartbeat-timeout > process-gone >
 * unknown.
 *
 * See change: bridge-disconnect-reason.
 */
import { describe, it, expect } from "vitest";
import { classifyBridgeDisconnect } from "../bridge-disconnect-classifier.js";
import type { BridgeDisconnectReason } from "../types.js";

describe("classifyBridgeDisconnect — each class maps to its reason", () => {
  it("clean-shutdown on WS close code 1000 (normal)", () => {
    expect(classifyBridgeDisconnect({ closeCode: 1000 })).toBe("clean-shutdown");
  });

  it("clean-shutdown on WS close code 1001 (going away)", () => {
    expect(classifyBridgeDisconnect({ closeCode: 1001 })).toBe("clean-shutdown");
  });

  it("heartbeat-timeout: non-clean close + heartbeat misses", () => {
    expect(classifyBridgeDisconnect({ closeCode: 1006, heartbeatMissed: true })).toBe("heartbeat-timeout");
  });

  it("process-gone: pid kill-0 miss (no heartbeat signal)", () => {
    expect(classifyBridgeDisconnect({ closeCode: 1006, pidAlive: false })).toBe("process-gone");
  });

  it("cross-wire: displaced by a newer registration", () => {
    expect(classifyBridgeDisconnect({ crossWire: true })).toBe("cross-wire");
  });

  it("unknown: no signals at all (MANDATORY, never blank)", () => {
    const r: BridgeDisconnectReason = classifyBridgeDisconnect({});
    expect(r).toBe("unknown");
    expect(r).not.toBe("");
  });

  it("unknown: non-clean close, no heartbeat miss, pid alive", () => {
    expect(classifyBridgeDisconnect({ closeCode: 1006, heartbeatMissed: false, pidAlive: true })).toBe("unknown");
  });
});

describe("classifyBridgeDisconnect — precedence (strongest signal wins)", () => {
  it("cross-wire beats a clean close code", () => {
    // The disconnect was CAUSED by the takeover even if the socket then closed
    // cleanly — displacement is the proximate cause.
    expect(classifyBridgeDisconnect({ crossWire: true, closeCode: 1000 })).toBe("cross-wire");
  });

  it("cross-wire beats heartbeat + process-gone", () => {
    expect(
      classifyBridgeDisconnect({ crossWire: true, heartbeatMissed: true, pidAlive: false }),
    ).toBe("cross-wire");
  });

  it("clean-shutdown beats a coincidental heartbeat miss", () => {
    expect(classifyBridgeDisconnect({ closeCode: 1000, heartbeatMissed: true })).toBe("clean-shutdown");
  });

  it("clean-shutdown beats process-gone (orderly close is authoritative)", () => {
    expect(classifyBridgeDisconnect({ closeCode: 1001, pidAlive: false })).toBe("clean-shutdown");
  });

  it("heartbeat-timeout beats process-gone (proximate cause was the hang)", () => {
    expect(classifyBridgeDisconnect({ closeCode: 1006, heartbeatMissed: true, pidAlive: false })).toBe(
      "heartbeat-timeout",
    );
  });
});

describe("classifyBridgeDisconnect — fail-loud contract", () => {
  it("every possible signal combination yields a non-empty reason", () => {
    const bools = [undefined, true, false];
    const codes = [undefined, 1000, 1001, 1006, 4999];
    const valid = new Set<BridgeDisconnectReason>([
      "heartbeat-timeout",
      "cross-wire",
      "process-gone",
      "clean-shutdown",
      "unknown",
    ]);
    for (const crossWire of bools) {
      for (const heartbeatMissed of bools) {
        for (const pidAlive of bools) {
          for (const closeCode of codes) {
            const r = classifyBridgeDisconnect({
              ...(crossWire !== undefined ? { crossWire } : {}),
              ...(heartbeatMissed !== undefined ? { heartbeatMissed } : {}),
              ...(pidAlive !== undefined ? { pidAlive } : {}),
              ...(closeCode !== undefined ? { closeCode } : {}),
            });
            expect(valid.has(r)).toBe(true);
            expect(r.length).toBeGreaterThan(0);
          }
        }
      }
    }
  });
});
