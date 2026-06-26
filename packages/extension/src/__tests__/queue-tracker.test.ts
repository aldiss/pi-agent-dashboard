/**
 * QueueTracker FIFO tests (dashboard-message-queue/v1).
 *
 * The bridge reconstructs pi's follow-up queue from observable signals (it
 * cannot read the AgentSession accessors — only `hasPendingMessages()`). These
 * tests pin the FIFO ordering, dequeue-pop, queueNonce reuse vs mint, and the
 * hasPendingMessages() clamp. See change: dashboard-message-queue.
 */
import { describe, it, expect } from "vitest";
import { QueueTracker } from "../queue-tracker.js";

describe("QueueTracker — enqueue + snapshot", () => {
  it("enqueueDashboard reuses the client-supplied queueNonce", () => {
    const qt = new QueueTracker();
    const ev = qt.enqueueDashboard("client-nonce-1", "hello");
    expect(ev.queueNonce).toBe("client-nonce-1");
    expect(ev.source).toBe("dashboard");
    expect(ev.text).toBe("hello");
    expect(qt.size()).toBe(1);
    expect(qt.snapshot("dashboard").followUp[0].queueNonce).toBe("client-nonce-1");
  });

  it("enqueueDashboard mints a nonce when none supplied (legacy client)", () => {
    const qt = new QueueTracker();
    const ev = qt.enqueueDashboard(undefined, "hi");
    expect(ev.queueNonce).toBeTruthy();
    expect(ev.source).toBe("dashboard");
  });

  it("enqueueTui mints a bridge-side nonce and tags source tui", () => {
    const qt = new QueueTracker();
    const ev = qt.enqueueTui("typed in terminal");
    expect(ev.queueNonce).toBeTruthy();
    expect(ev.source).toBe("tui");
    expect(qt.size()).toBe(1);
  });

  it("snapshot reports pendingMessageCount = followUp length, steeringCount 0", () => {
    const qt = new QueueTracker();
    qt.enqueueDashboard("a", "1");
    qt.enqueueDashboard("b", "2");
    const snap = qt.snapshot("dashboard");
    expect(snap.followUp.map((f) => f.queueNonce)).toEqual(["a", "b"]);
    expect(snap.pendingMessageCount).toBe(2);
    expect(snap.steeringCount).toBe(0);
  });

  it("carries images on the message_enqueued event data", () => {
    const qt = new QueueTracker();
    const ev = qt.enqueueDashboard("a", "look", [
      { type: "image", data: "ZZ", mimeType: "image/png" } as any,
    ]);
    expect(ev.images).toHaveLength(1);
  });
});

describe("QueueTracker — classifyDequeue (steer-vs-followUp, text-match)", () => {
  it("dispatches the follow-up HEAD only on a text-match (FIFO order)", () => {
    const qt = new QueueTracker();
    qt.enqueueDashboard("first", "do A");
    qt.enqueueTui("do B"); // bridge-minted nonce
    qt.enqueueDashboard("third", "do C");
    // Head matches → pops "first".
    expect(qt.classifyDequeue("do A")).toBe("first");
    // New head is the TUI entry "do B" (minted nonce) — matches by text.
    const second = qt.classifyDequeue("do B");
    expect(second).toBeTruthy();
    expect(second).not.toBe("third");
    expect(qt.classifyDequeue("do C")).toBe("third");
    expect(qt.size()).toBe(0);
  });

  it("does NOT pop when the committing text does not match the head", () => {
    const qt = new QueueTracker();
    qt.enqueueDashboard("head", "queued follow-up");
    // A turn-initiating / untracked message commits with unrelated text.
    expect(qt.classifyDequeue("something else entirely")).toBeUndefined();
    // The follow-up card stays queued — NOT falsely dispatched.
    expect(qt.size()).toBe(1);
  });

  it("classifyDequeue on an empty model returns undefined", () => {
    const qt = new QueueTracker();
    expect(qt.classifyDequeue("anything")).toBeUndefined();
  });

  it("empty text never pops (mirrors pi's `if (messageText)` guard)", () => {
    const qt = new QueueTracker();
    qt.enqueueDashboard("head", ""); // pathological empty-text entry
    expect(qt.classifyDequeue("")).toBeUndefined();
    expect(qt.size()).toBe(1);
  });
});

describe("QueueTracker — steering (recordSteer + steering-first removal)", () => {
  it("a committing message matching a tracked steer is removed steering-first, dispatches nothing", () => {
    const qt = new QueueTracker();
    qt.recordSteer("steer text");
    expect(qt.classifyDequeue("steer text")).toBeUndefined();
    // Re-committing the same text would NOT find the steer again (it was removed).
    // (No follow-up entries exist, so still undefined.)
    expect(qt.classifyDequeue("steer text")).toBeUndefined();
  });

  it("steering-first: a steer is preferred even when a follow-up has identical text", () => {
    const qt = new QueueTracker();
    qt.enqueueDashboard("fu-nonce", "same text");
    qt.recordSteer("same text");
    // pi removes from steering FIRST → the follow-up card must survive.
    expect(qt.classifyDequeue("same text")).toBeUndefined();
    expect(qt.size()).toBe(1); // follow-up still queued
    // A subsequent commit of the same text now matches the follow-up head.
    expect(qt.classifyDequeue("same text")).toBe("fu-nonce");
    expect(qt.size()).toBe(0);
  });
});

describe("QueueTracker — AMEND #1 INTERLEAVE: TUI steer must not dispatch a queued follow-up card", () => {
  it("enqueue dashboard followUp → TUI steer (non-matching text) commits → followUp NOT dispatched", () => {
    const qt = new QueueTracker();
    // 1. A dashboard follow-up is queued (card present in the FIFO).
    qt.enqueueDashboard("dash-card-1", "please run the tests");
    expect(qt.size()).toBe(1);

    // 2. The operator types a STEER in pi's own TUI while streaming. The bridge
    //    input-listener records it (no card, no message_enqueued).
    qt.recordSteer("actually, focus on the parser bug");

    // 3. The steer commits → message_start(role:user) with the STEER's text.
    //    Pre-fix, this blind-popped the followUp head. classifyDequeue must
    //    NOT dispatch the dashboard follow-up card.
    const dispatched = qt.classifyDequeue("actually, focus on the parser bug");
    expect(dispatched).toBeUndefined();

    // The dashboard follow-up card is STILL queued — not falsely "dispatched".
    expect(qt.size()).toBe(1);

    // 4. Later, the follow-up itself is pulled into work → its text commits →
    //    NOW it dispatches (correct edge), stamping its real queueNonce.
    expect(qt.classifyDequeue("please run the tests")).toBe("dash-card-1");
    expect(qt.size()).toBe(0);
  });
});


describe("QueueTracker — hasPendingMessages clamp", () => {
  it("clampEmpty(false) hard-resyncs a non-empty model to empty", () => {
    const qt = new QueueTracker();
    qt.enqueueDashboard("a", "1");
    qt.enqueueDashboard("b", "2");
    const changed = qt.clampEmpty(false);
    expect(changed).toBe(true);
    expect(qt.size()).toBe(0);
  });

  it("clampEmpty(true) leaves a non-empty model intact", () => {
    const qt = new QueueTracker();
    qt.enqueueDashboard("a", "1");
    const changed = qt.clampEmpty(true);
    expect(changed).toBe(false);
    expect(qt.size()).toBe(1);
  });

  it("clampEmpty(false) on an already-empty model is a no-op", () => {
    const qt = new QueueTracker();
    expect(qt.clampEmpty(false)).toBe(false);
  });
});
