/**
 * M-F — the bounded, sub-owned, TTL'd reservation primitive.
 *
 * The 3 falsifiable tests the design mandates (v2.1 §M-F):
 *  (a) a 3rd distinct sub is REFUSED during the hold;
 *  (b) the hold SELF-EXPIRES and frees the slot (no permanent wedge);
 *  (c) the owning sub RECLAIMS within the TTL.
 *
 * Plus: the reservation counts against N=2, is owner-bound, and clearSession is
 * the leak guard. Uses fake timers to drive the TTL deterministically.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createOperatorSetTracker } from "../operator-set-tracker.js";

const S = "sess-1";
const OP1 = "op1@example.com";
const OP2 = "op2@example.com";
const OP3 = "op3@example.com";
const TTL = 25_000; // ~25s, the brief's reload-tuned default

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("M-F reserve — (a) a 3rd distinct sub is refused during the hold", () => {
  it("a reservation + a member fill N=2; a 3rd distinct sub is refused", () => {
    const t = createOperatorSetTracker();
    t.commit(S, OP1);                 // op1 is a committed member
    expect(t.reserve(S, OP2, TTL)).toBe(true); // op2 reserves the 2nd slot
    // The cell is now full (op1 member + op2 reserved). A 3rd distinct sub:
    expect(t.canAdmit(S, OP3).admissible).toBe(false);
    // And a direct reserve by the 3rd sub is refused too.
    expect(t.reserve(S, OP3, TTL)).toBe(false);
  });

  it("two reservations alone fill N=2 (a 3rd is refused)", () => {
    const t = createOperatorSetTracker();
    expect(t.reserve(S, OP1, TTL)).toBe(true);
    expect(t.reserve(S, OP2, TTL)).toBe(true);
    expect(t.canAdmit(S, OP3).admissible).toBe(false);
  });
});

describe("M-F reserve — (b) the hold self-expires and frees the slot", () => {
  it("after the TTL, the reserved slot frees (no permanent wedge)", () => {
    const t = createOperatorSetTracker();
    t.commit(S, OP1);
    t.reserve(S, OP2, TTL);
    expect(t.canAdmit(S, OP3).admissible).toBe(false); // held
    vi.advanceTimersByTime(TTL + 1);                    // TTL elapses
    // The reservation self-evicted → the slot is free → the 3rd sub is admissible.
    expect(t.canAdmit(S, OP3).admissible).toBe(true);
  });

  it("a lone stale reservation does not wedge the cell forever", () => {
    const t = createOperatorSetTracker();
    t.reserve(S, OP1, TTL);
    t.reserve(S, OP2, TTL); // both slots reserved
    vi.advanceTimersByTime(TTL + 1);
    // Both evicted → the cell is fully usable again.
    expect(t.canAdmit(S, OP1).admissible).toBe(true);
    expect(t.canAdmit(S, OP2).admissible).toBe(true);
    expect(t.canAdmit(S, OP3).admissible).toBe(true);
  });
});

describe("M-F reserve — (c) the owning sub reclaims within the TTL", () => {
  it("the SAME sub reclaims its reserved slot before expiry", () => {
    const t = createOperatorSetTracker();
    t.commit(S, OP1);
    t.reserve(S, OP2, TTL);   // op2's slot held across its reload
    vi.advanceTimersByTime(TTL / 2); // still within the window
    // op2 reconnects → canAdmit says admissible (reclaim), NOT member yet.
    const verdict = t.canAdmit(S, OP2);
    expect(verdict.admissible).toBe(true);
    // The caller commits op2 back into its slot.
    t.commit(S, OP2);
    expect(t.operatorsOf(S).sort()).toEqual([OP1, OP2].sort());
  });

  it("the reservation is owner-bound: a different sub cannot claim it", () => {
    const t = createOperatorSetTracker();
    t.reserve(S, OP1, TTL);
    t.commit(S, OP2); // 2nd slot taken by a real member
    // The cell is full (op1 reserved + op2 member); op3 cannot take op1's slot.
    expect(t.canAdmit(S, OP3).admissible).toBe(false);
    // op1 (the owner) still reclaims within TTL.
    expect(t.canAdmit(S, OP1).admissible).toBe(true);
  });
});

describe("M-F reserve — release + clearSession semantics", () => {
  it("release of a member LEAVES a live reservation intact (survives the reload gap)", () => {
    const t = createOperatorSetTracker();
    t.commit(S, OP1);
    t.reserve(S, OP1, TTL); // op1 reserves its own slot before the socket closes
    t.release(S, OP1);      // last socket closes → member dropped
    // The reservation survives the release → a 3rd sub still cannot take the slot
    // while op2 also holds one.
    t.commit(S, OP2);
    expect(t.canAdmit(S, OP3).admissible).toBe(false);
    // op1 reclaims within TTL.
    expect(t.canAdmit(S, OP1).admissible).toBe(true);
  });

  it("clearSession clears reservation timers (leak guard)", () => {
    const t = createOperatorSetTracker();
    t.reserve(S, OP1, TTL);
    t.reserve(S, OP2, TTL);
    t.clearSession(S);
    // Everything freed immediately.
    expect(t.canAdmit(S, OP3).admissible).toBe(true);
    expect(t.operatorsOf(S)).toEqual([]);
  });

  it("re-reserving the same sub refreshes the TTL (idempotent)", () => {
    const t = createOperatorSetTracker();
    t.reserve(S, OP1, TTL);
    vi.advanceTimersByTime(TTL - 1000); // almost expired
    t.reserve(S, OP1, TTL);             // refresh
    vi.advanceTimersByTime(2000);       // past the ORIGINAL expiry, within the new
    expect(t.canAdmit(S, OP1).admissible).toBe(true); // still held (refreshed)
  });
});

describe("M-F reserve — operatorsOf semantics unchanged (committed members only)", () => {
  it("a reservation does NOT appear in operatorsOf until committed", () => {
    const t = createOperatorSetTracker();
    t.reserve(S, OP1, TTL);
    // operatorsOf reflects committed membership only (the C5 audience gate uses
    // it — a reserved-but-not-connected sub is not yet an audience member).
    expect(t.operatorsOf(S)).toEqual([]);
    t.commit(S, OP1);
    expect(t.operatorsOf(S)).toEqual([OP1]);
  });
});
