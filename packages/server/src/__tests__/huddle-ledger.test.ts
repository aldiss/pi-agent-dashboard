/**
 * C1 — huddle ledger unit coverage.
 *
 * Proves the load-bearing C1 guarantees:
 *  - RECORD-TIME AUTHORITY: `seq` is monotonic per (session, epoch); `recordedAt`
 *    comes from the injected server clock, NEVER from the input.
 *  - SPLIT CONSUMERS (audience-broadcast ⊥ agent-delivery): the audience view and
 *    the agent-delivery cursor are INDEPENDENT — draining the agent hold does not
 *    consume the audience view; recording fires the audience callback without
 *    advancing the agent cursor.
 *  - EPOCH ISOLATION: a later epoch's span is separate; `clearSession` sweeps all
 *    epochs for a session (leak guard).
 *  - HELD-IMAGE DETECTION: `heldSpanHasImages` reflects only UNDRAINED turns — the
 *    hook C4 fail-louds on (policy B).
 */
import { describe, it, expect, vi } from "vitest";
import { createHuddleLedger } from "../huddle-ledger.js";
import type { HuddleTurnInput } from "@blackbelt-technology/pi-dashboard-shared/huddle.js";

const OP1 = { sub: "op1@example.com", display: "Op One", isOperator: true };
const OP2 = { sub: "op2@example.com", display: "Op Two", isOperator: false };

function turn(over: Partial<HuddleTurnInput> = {}): HuddleTurnInput {
  return {
    sessionId: "s1",
    epoch: 1,
    kind: "human_turn",
    author: OP1,
    role: "operator",
    origin: "ws",
    gateResult: "raw",
    text: "hold on, let me confer",
    ...over,
  };
}

describe("C1 huddle ledger — record-time authority", () => {
  it("assigns monotonic seq per (session, epoch) starting at 0", () => {
    const ledger = createHuddleLedger();
    const a = ledger.record(turn());
    const b = ledger.record(turn({ author: OP2, role: "guest" }));
    const c = ledger.record(turn());
    expect([a.seq, b.seq, c.seq]).toEqual([0, 1, 2]);
  });

  it("stamps recordedAt from the injected clock, not the input", () => {
    const clock = vi.fn<() => number>().mockReturnValueOnce(1000).mockReturnValueOnce(2000);
    const ledger = createHuddleLedger({ now: clock });
    // The input has NO recordedAt/seq — they are the ledger's authority.
    const a = ledger.record(turn());
    const b = ledger.record(turn());
    expect(a.recordedAt).toBe(1000);
    expect(b.recordedAt).toBe(2000);
  });

  it("isolates seq counters across distinct epochs", () => {
    const ledger = createHuddleLedger();
    const e1 = ledger.record(turn({ epoch: 1 }));
    const e2 = ledger.record(turn({ epoch: 2 }));
    expect(e1.seq).toBe(0);
    expect(e2.seq).toBe(0); // a fresh epoch restarts the seq
    expect(ledger.turnsOf("s1", 1)).toHaveLength(1);
    expect(ledger.turnsOf("s1", 2)).toHaveLength(1);
  });
});

describe("C1 huddle ledger — SPLIT consumers (audience ⊥ agent)", () => {
  it("fires the audience-broadcast callback synchronously for every recorded turn", () => {
    const seen: number[] = [];
    const ledger = createHuddleLedger({ onAudienceTurn: (t) => seen.push(t.seq) });
    ledger.record(turn());
    ledger.record(turn());
    expect(seen).toEqual([0, 1]);
  });

  it("draining the agent hold does NOT consume the audience/audit view", () => {
    const ledger = createHuddleLedger();
    ledger.record(turn());
    ledger.record(turn());
    const drained = ledger.drainAgentHold("s1", 1);
    expect(drained.map((t) => t.seq)).toEqual([0, 1]);
    // Audience/audit view is untouched by the agent drain — the whole point.
    expect(ledger.turnsOf("s1", 1).map((t) => t.seq)).toEqual([0, 1]);
  });

  it("recording fires the audience callback WITHOUT advancing the agent cursor", () => {
    const seen: number[] = [];
    const ledger = createHuddleLedger({ onAudienceTurn: (t) => seen.push(t.seq) });
    ledger.record(turn());
    // Audience saw it; but the agent hold still holds it (cursor did not move).
    expect(seen).toEqual([0]);
    expect(ledger.agentHold("s1", 1).map((t) => t.seq)).toEqual([0]);
  });

  it("drainAgentHold is exactly-once: a second recall re-delivers nothing", () => {
    const ledger = createHuddleLedger();
    ledger.record(turn());
    ledger.record(turn());
    expect(ledger.drainAgentHold("s1", 1)).toHaveLength(2);
    expect(ledger.drainAgentHold("s1", 1)).toHaveLength(0);
  });

  it("turns recorded AFTER a drain are held for the next drain only", () => {
    const ledger = createHuddleLedger();
    ledger.record(turn()); // seq 0
    ledger.drainAgentHold("s1", 1); // drains [0]
    ledger.record(turn()); // seq 1 — held past the cursor
    expect(ledger.agentHold("s1", 1).map((t) => t.seq)).toEqual([1]);
    expect(ledger.drainAgentHold("s1", 1).map((t) => t.seq)).toEqual([1]);
  });
});

describe("C1 huddle ledger — held-image detection (policy B hook)", () => {
  it("reports images only among UNDRAINED held turns", () => {
    const img = [{ type: "image" as const, data: "x", mimeType: "image/png" }];
    const ledger = createHuddleLedger();
    ledger.record(turn({ images: img })); // seq 0 — image-bearing
    expect(ledger.heldSpanHasImages("s1", 1)).toBe(true);
    ledger.drainAgentHold("s1", 1); // drain past it
    // After drain, the image-bearing turn is no longer HELD.
    expect(ledger.heldSpanHasImages("s1", 1)).toBe(false);
  });

  it("is false for a text-only held span", () => {
    const ledger = createHuddleLedger();
    ledger.record(turn());
    ledger.record(turn({ author: OP2, role: "guest" }));
    expect(ledger.heldSpanHasImages("s1", 1)).toBe(false);
  });
});

describe("C1 huddle ledger — clearSession leak guard", () => {
  it("sweeps all epochs for a session", () => {
    const ledger = createHuddleLedger();
    ledger.record(turn({ epoch: 1 }));
    ledger.record(turn({ epoch: 2 }));
    ledger.clearSession("s1");
    expect(ledger.turnsOf("s1", 1)).toHaveLength(0);
    expect(ledger.turnsOf("s1", 2)).toHaveLength(0);
  });

  it("does not touch a different session's spans", () => {
    const ledger = createHuddleLedger();
    ledger.record(turn({ sessionId: "s1" }));
    ledger.record(turn({ sessionId: "s2" }));
    ledger.clearSession("s1");
    expect(ledger.turnsOf("s1", 1)).toHaveLength(0);
    expect(ledger.turnsOf("s2", 1)).toHaveLength(1);
  });
});
