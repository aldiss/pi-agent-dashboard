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

describe("QueueTracker — dequeue (FIFO)", () => {
  it("dequeueHead pops in FIFO order and returns the queueNonce", () => {
    const qt = new QueueTracker();
    qt.enqueueDashboard("first", "1");
    qt.enqueueTui("2"); // bridge-minted nonce
    qt.enqueueDashboard("third", "3");
    expect(qt.dequeueHead()).toBe("first");
    // second is TUI (minted) — just assert order shrank and third is last.
    const second = qt.dequeueHead();
    expect(second).toBeTruthy();
    expect(second).not.toBe("third");
    expect(qt.dequeueHead()).toBe("third");
    expect(qt.size()).toBe(0);
  });

  it("dequeueHead on an empty queue returns undefined (turn-initiating message)", () => {
    const qt = new QueueTracker();
    expect(qt.dequeueHead()).toBeUndefined();
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
