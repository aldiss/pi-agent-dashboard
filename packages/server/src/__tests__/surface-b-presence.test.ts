/**
 * Surface B — presence red-arms (server-side).
 *
 *  #4 BA-4 greenfield presence — the NO-OP `getAgentPresence` returns `null`
 *     and contributes NO agent participant; the presence set stays humans-only
 *     and additive-only (no perturbation). Red-arm: make it return a bogus
 *     participant → the additive-only / humans-only assertion FAILS.
 *  #5 presence-of-two per-PRINCIPAL (not per-WebSocket) — two tabs of the SAME
 *     human = ONE participant; two DISTINCT humans = two. Red-arm: dedup by
 *     WebSocket instead of `sub` → two tabs show as two → FAILS.
 *  #4b free-for-all (B4) — the presence tracker adds NO send-lock/turn gate;
 *     presence is observational only. Pinned as a structural assertion.
 */
import { describe, it, expect } from "vitest";
import { createSessionPresenceTracker } from "../session-presence-tracker.js";
import { getAgentPresence } from "../agent-presence.js";

// Fake WebSocket handles — identity only (the tracker keys by reference).
function ws(): any {
  return {};
}

const OP1 = { sub: "op1@example.com", display: "Op One" };
const OP2 = { sub: "op2@example.com", display: "Op Two" };

describe("Surface B #5 — presence-of-two is per-PRINCIPAL, not per-WebSocket", () => {
  it("two TABS of the SAME human = ONE participant", () => {
    const t = createSessionPresenceTracker();
    const tabA = ws();
    const tabB = ws();
    const firstChanged = t.enter("s1", tabA, OP1);
    const secondChanged = t.enter("s1", tabB, OP1); // same human, second tab
    expect(firstChanged).toBe(true);   // new human appeared
    expect(secondChanged).toBe(false); // same human → distinct set unchanged
    expect(t.humanCount("s1")).toBe(1);
    expect(t.humansOf("s1")).toEqual([{ id: "op1@example.com", kind: "human", display: "Op One" }]);
  });

  it("two DISTINCT humans = TWO participants (presence-of-two)", () => {
    const t = createSessionPresenceTracker();
    expect(t.enter("s1", ws(), OP1)).toBe(true);
    expect(t.enter("s1", ws(), OP2)).toBe(true);
    expect(t.humanCount("s1")).toBe(2);
    const subs = t.humansOf("s1").map((p) => p.id).sort();
    expect(subs).toEqual(["op1@example.com", "op2@example.com"]);
  });

  it("a human leaves only when their LAST tab closes", () => {
    const t = createSessionPresenceTracker();
    const tabA = ws();
    const tabB = ws();
    t.enter("s1", tabA, OP1);
    t.enter("s1", tabB, OP1);
    expect(t.leave("s1", tabA)).toBe(false); // still present via tabB
    expect(t.humanCount("s1")).toBe(1);
    expect(t.leave("s1", tabB)).toBe(true);  // last tab → human left
    expect(t.humanCount("s1")).toBe(0);
  });

  it("removeSocket (disconnect) drops the human from every session, reporting changes", () => {
    const t = createSessionPresenceTracker();
    const sock = ws();
    t.enter("s1", sock, OP1);
    t.enter("s2", sock, OP1);
    const changed = t.removeSocket(sock).sort();
    expect(changed).toEqual(["s1", "s2"]);
    expect(t.humanCount("s1")).toBe(0);
    expect(t.humanCount("s2")).toBe(0);
  });

  it("single-operator (null principal) contributes NO presence (byte-unchanged)", () => {
    const t = createSessionPresenceTracker();
    expect(t.enter("s1", ws(), null)).toBe(false);
    expect(t.humanCount("s1")).toBe(0);
    expect(t.humansOf("s1")).toEqual([]);
  });
});

describe("Surface B #4 — BA-4 greenfield agent-presence NO-OP", () => {
  it("getAgentPresence returns null for any session (no agent participant today)", () => {
    expect(getAgentPresence("s1")).toBeNull();
    expect(getAgentPresence("anything")).toBeNull();
  });

  it("the presence set stays humans-only + additive (agent contributes nothing)", () => {
    const t = createSessionPresenceTracker();
    t.enter("s1", ws(), OP1);
    t.enter("s1", ws(), OP2);
    // Mirror the server's buildPresenceParticipants union logic.
    const humans = t.humansOf("s1");
    const agent = getAgentPresence("s1");
    const participants = agent ? [...humans, agent] : humans;
    // additive-only: participants === humans (no agent appended, no human
    // dropped/perturbed).
    expect(participants).toHaveLength(2);
    expect(participants.every((p) => p.kind === "human")).toBe(true);
    expect(participants).toEqual(humans);
  });
});
