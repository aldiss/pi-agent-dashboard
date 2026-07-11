/**
 * C3 — huddle state-machine unit coverage.
 *
 * Proves the serialized CAS + epoch discipline:
 *  - LEGAL CYCLE: idle→arming→active→recalling→idle advances only on the right
 *    predecessor + a matching-epoch bridge ack.
 *  - CAS REFUSAL: a transition from the wrong phase is refused (`wrong-phase`),
 *    not silently applied — two concurrent arms / a recall racing an arm cannot
 *    interleave.
 *  - EPOCH GUARD: a stale ack (wrong epoch, e.g. a prior span's bridge reconnect)
 *    is DROPPED — it never advances the SM.
 *  - DURABLE OUTBOX: held executable prompts survive the span and drain once.
 */
import { describe, it, expect } from "vitest";
import { createHuddleStateMachine } from "../huddle-state-machine.js";

const S = "sess-1";

describe("C3 huddle SM — the legal cycle", () => {
  it("advances idle→arming→active→recalling→idle on matching-epoch acks", () => {
    const sm = createHuddleStateMachine();
    expect(sm.phaseOf(S)).toBe("idle");
    expect(sm.epochOf(S)).toBe(0);

    const arm = sm.requestArm(S);
    expect(arm).toEqual({ ok: true, epoch: 1, phase: "arming" });
    expect(sm.isHuddling(S)).toBe(true);

    expect(sm.ackActive(S, 1)).toEqual({ ok: true, epoch: 1, phase: "active" });
    expect(sm.requestRecall(S)).toEqual({ ok: true, epoch: 1, phase: "recalling" });
    expect(sm.ackIdle(S, 1)).toEqual({ ok: true, epoch: 1, phase: "idle" });
    expect(sm.isHuddling(S)).toBe(false);
  });

  it("bumps the epoch on each fresh arm (span isolation)", () => {
    const sm = createHuddleStateMachine();
    sm.requestArm(S);
    sm.ackActive(S, 1);
    sm.requestRecall(S);
    sm.ackIdle(S, 1);
    const arm2 = sm.requestArm(S);
    expect(arm2).toEqual({ ok: true, epoch: 2, phase: "arming" });
  });
});

describe("C3 huddle SM — CAS refusal (serialized, no interleave)", () => {
  it("refuses a second arm while already arming (idle-only precondition)", () => {
    const sm = createHuddleStateMachine();
    sm.requestArm(S);
    const second = sm.requestArm(S);
    expect(second).toEqual({ ok: false, reason: "wrong-phase", phase: "arming" });
  });

  it("refuses recall before active", () => {
    const sm = createHuddleStateMachine();
    sm.requestArm(S); // arming, not yet active
    expect(sm.requestRecall(S)).toEqual({ ok: false, reason: "wrong-phase", phase: "arming" });
  });

  it("refuses ackIdle when not recalling", () => {
    const sm = createHuddleStateMachine();
    sm.requestArm(S);
    sm.ackActive(S, 1); // active, not recalling
    expect(sm.ackIdle(S, 1)).toEqual({ ok: false, reason: "wrong-phase", phase: "active" });
  });
});

describe("C3 huddle SM — epoch guard (stale acks dropped)", () => {
  it("drops an ackActive whose epoch is stale", () => {
    const sm = createHuddleStateMachine();
    sm.requestArm(S); // epoch 1, arming
    // A stale ack from a hypothetical prior span (epoch 0) must not advance.
    expect(sm.ackActive(S, 0)).toEqual({ ok: false, reason: "wrong-phase", phase: "arming" });
    expect(sm.phaseOf(S)).toBe("arming"); // unchanged
    // The correct-epoch ack advances.
    expect(sm.ackActive(S, 1).ok).toBe(true);
  });

  it("drops an ackIdle whose epoch is stale", () => {
    const sm = createHuddleStateMachine();
    sm.requestArm(S);
    sm.ackActive(S, 1);
    sm.requestRecall(S); // epoch 1, recalling
    expect(sm.ackIdle(S, 99)).toEqual({ ok: false, reason: "wrong-phase", phase: "recalling" });
    expect(sm.phaseOf(S)).toBe("recalling");
  });
});

describe("C3 huddle SM — durable outbox", () => {
  it("holds executable prompts across the span and drains once", () => {
    const sm = createHuddleStateMachine();
    sm.requestArm(S);
    sm.ackActive(S, 1);
    sm.holdOutbox(S, { text: "resume me", source: "resume-replay", author: { sub: "op1", display: "Op One" } });
    sm.holdOutbox(S, { text: "and me", source: "resume-replay" });
    expect(sm.outboxOf(S)).toHaveLength(2);
    sm.requestRecall(S);
    sm.ackIdle(S, 1);
    const drained = sm.drainOutbox(S);
    expect(drained.map((p) => p.text)).toEqual(["resume me", "and me"]);
    // Draining is exactly-once.
    expect(sm.drainOutbox(S)).toHaveLength(0);
  });

  it("preserves the record-time author on a held prompt", () => {
    const sm = createHuddleStateMachine();
    sm.requestArm(S);
    sm.holdOutbox(S, { text: "x", source: "resume-replay", author: { sub: "op2@e.com", display: "Op Two", isOperator: false } });
    expect(sm.drainOutbox(S)[0]!.author).toEqual({ sub: "op2@e.com", display: "Op Two", isOperator: false });
  });
});

describe("C3 huddle SM — clearSession leak guard", () => {
  it("resets phase, epoch, and outbox for a session", () => {
    const sm = createHuddleStateMachine();
    sm.requestArm(S);
    sm.holdOutbox(S, { text: "x", source: "resume-replay" });
    sm.clearSession(S);
    expect(sm.phaseOf(S)).toBe("idle");
    expect(sm.epochOf(S)).toBe(0);
    expect(sm.outboxOf(S)).toHaveLength(0);
  });
});
