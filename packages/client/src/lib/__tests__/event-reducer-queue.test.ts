/**
 * Message-queue lifecycle reducer tests (dashboard-message-queue/v1).
 *
 * Covers the visible queue state machine the bridge drives via event_forward:
 *   - message_enqueued → confirm an optimistic entry OR append (TUI-origin)
 *   - queue_state      → atomic-REPLACE confirmed portion, PRESERVE optimistic/failed
 *   - message_start(queueNonce) → dispatch: remove that entry, push committed bubble
 *   - markQueueEntryFailed / removeQueueEntry helpers (stuck-timeout + dismiss)
 *   - degenerate single-slot pendingPrompt path is UNTOUCHED by queue events
 *
 * Sister to use-message-handler-pending-prompt.test.ts. See change:
 * dashboard-message-queue.
 */
import { describe, it, expect } from "vitest";
import {
  createInitialState,
  reduceEvent,
  markQueueEntryFailed,
  removeQueueEntry,
  type SessionState,
  type QueuedMessage,
} from "../event-reducer.js";
import type { DashboardEvent } from "@blackbelt-technology/pi-dashboard-shared/types.js";

const TS = 1777032001000;

function ev(eventType: string, data: Record<string, unknown>): DashboardEvent {
  return { eventType, timestamp: TS, data } as DashboardEvent;
}

/** A state with one optimistic dashboard-origin queued entry. */
function stateWithOptimistic(queueNonce: string, text: string): SessionState {
  const s = createInitialState();
  s.queue = [
    { queueNonce, text, state: "optimistic", source: "dashboard", createdAt: TS - 1000 },
  ];
  return s;
}

describe("event-reducer queue: message_enqueued", () => {
  it("confirms a matching optimistic entry (reconcile by queueNonce)", () => {
    const s0 = stateWithOptimistic("q-1", "hello");
    const s1 = reduceEvent(s0, ev("message_enqueued", {
      queueNonce: "q-1", text: "hello", source: "dashboard",
    }));
    expect(s1.queue).toHaveLength(1);
    expect(s1.queue[0].state).toBe("confirmed");
    expect(s1.queue[0].queueNonce).toBe("q-1");
    // createdAt preserved from the optimistic entry (stable ordering).
    expect(s1.queue[0].createdAt).toBe(TS - 1000);
  });

  it("appends a fresh confirmed entry when no optimistic match (TUI-origin)", () => {
    const s0 = createInitialState();
    const s1 = reduceEvent(s0, ev("message_enqueued", {
      queueNonce: "q-tui-1", text: "from terminal", source: "tui",
    }));
    expect(s1.queue).toHaveLength(1);
    expect(s1.queue[0]).toMatchObject({
      queueNonce: "q-tui-1", text: "from terminal", state: "confirmed", source: "tui",
    });
  });

  it("is idempotent for an already-confirmed nonce", () => {
    const s0 = createInitialState();
    const s1 = reduceEvent(s0, ev("message_enqueued", { queueNonce: "q-1", text: "x", source: "dashboard" }));
    const s2 = reduceEvent(s1, ev("message_enqueued", { queueNonce: "q-1", text: "x", source: "dashboard" }));
    expect(s2.queue).toHaveLength(1);
  });

  it("maps wire images onto the queued entry", () => {
    const s0 = stateWithOptimistic("q-img", "look");
    const s1 = reduceEvent(s0, ev("message_enqueued", {
      queueNonce: "q-img", text: "look", source: "dashboard",
      images: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
    }));
    expect(s1.queue[0].images).toEqual([{ data: "AAAA", mimeType: "image/png" }]);
  });
});

describe("event-reducer queue: queue_state (atomic replace)", () => {
  it("replaces the confirmed portion with pi's authoritative order", () => {
    // Start with two confirmed entries in one order…
    const s0 = createInitialState();
    s0.queue = [
      { queueNonce: "a", text: "first", state: "confirmed", source: "dashboard", createdAt: TS },
      { queueNonce: "b", text: "second", state: "confirmed", source: "dashboard", createdAt: TS },
    ];
    // …snapshot says only "b" remains (a was dispatched).
    const s1 = reduceEvent(s0, ev("queue_state", {
      followUp: [{ queueNonce: "b", text: "second" }],
      steeringCount: 0,
      pendingMessageCount: 1,
      source: "lifecycle",
    }));
    expect(s1.queue).toHaveLength(1);
    expect(s1.queue[0].queueNonce).toBe("b");
    expect(s1.queue[0].state).toBe("confirmed");
  });

  it("preserves optimistic + failed entries NOT in the snapshot (after the confirmed block)", () => {
    const s0 = createInitialState();
    s0.queue = [
      { queueNonce: "c1", text: "confirmed1", state: "confirmed", source: "dashboard", createdAt: TS },
      { queueNonce: "opt", text: "still-inflight", state: "optimistic", source: "dashboard", createdAt: TS + 1 },
      { queueNonce: "fail", text: "lost", state: "failed", source: "dashboard", createdAt: TS + 2 },
    ];
    const s1 = reduceEvent(s0, ev("queue_state", {
      followUp: [{ queueNonce: "c1", text: "confirmed1" }],
      steeringCount: 0,
      pendingMessageCount: 1,
      source: "lifecycle",
    }));
    // confirmed block first (c1), then preserved optimistic + failed.
    expect(s1.queue.map((q) => q.queueNonce)).toEqual(["c1", "opt", "fail"]);
    expect(s1.queue[1].state).toBe("optimistic");
    expect(s1.queue[2].state).toBe("failed");
  });

  it("drops a prior confirmed entry absent from the snapshot", () => {
    const s0 = createInitialState();
    s0.queue = [
      { queueNonce: "gone", text: "dispatched-or-cleared", state: "confirmed", source: "dashboard", createdAt: TS },
    ];
    const s1 = reduceEvent(s0, ev("queue_state", {
      followUp: [], steeringCount: 0, pendingMessageCount: 0, source: "lifecycle",
    }));
    expect(s1.queue).toHaveLength(0);
  });

  it("empty snapshot clears confirmed but keeps an optimistic in-flight entry", () => {
    const s0 = stateWithOptimistic("opt-1", "racing the snapshot");
    const s1 = reduceEvent(s0, ev("queue_state", {
      followUp: [], steeringCount: 0, pendingMessageCount: 0, source: "lifecycle",
    }));
    expect(s1.queue).toHaveLength(1);
    expect(s1.queue[0].state).toBe("optimistic");
  });
});

describe("event-reducer queue: message_start(queueNonce) dispatch", () => {
  it("removes exactly the dispatched entry and pushes the committed user bubble", () => {
    const s0 = createInitialState();
    s0.queue = [
      { queueNonce: "head", text: "do the thing", state: "confirmed", source: "dashboard", createdAt: TS },
      { queueNonce: "tail", text: "then this", state: "confirmed", source: "dashboard", createdAt: TS + 1 },
    ];
    const s1 = reduceEvent(s0, ev("message_start", {
      message: { role: "user", content: [{ type: "text", text: "do the thing" }] },
      queueNonce: "head",
      nonce: "n-1",
    }));
    // head removed from queue; tail remains.
    expect(s1.queue.map((q) => q.queueNonce)).toEqual(["tail"]);
    // committed user bubble pushed.
    const last = s1.messages[s1.messages.length - 1];
    expect(last.role).toBe("user");
    expect(last.content).toBe("do the thing");
  });

  it("a user message_start WITHOUT queueNonce leaves the queue intact (turn-initiating message)", () => {
    const s0 = createInitialState();
    s0.queue = [
      { queueNonce: "x", text: "queued", state: "confirmed", source: "dashboard", createdAt: TS },
    ];
    const s1 = reduceEvent(s0, ev("message_start", {
      message: { role: "user", content: [{ type: "text", text: "an unrelated initiating msg" }] },
      nonce: "n-2",
    }));
    expect(s1.queue).toHaveLength(1);
    expect(s1.queue[0].queueNonce).toBe("x");
  });
});

describe("event-reducer queue: helpers", () => {
  it("markQueueEntryFailed flips an optimistic entry to failed", () => {
    const s0 = stateWithOptimistic("q-1", "stuck");
    const s1 = markQueueEntryFailed(s0, "q-1");
    expect(s1.queue[0].state).toBe("failed");
  });

  it("markQueueEntryFailed no-ops on a confirmed entry (returns same ref)", () => {
    const s0 = createInitialState();
    s0.queue = [{ queueNonce: "q-1", text: "ok", state: "confirmed", source: "dashboard", createdAt: TS }];
    const s1 = markQueueEntryFailed(s0, "q-1");
    expect(s1).toBe(s0);
  });

  it("removeQueueEntry removes an optimistic or failed entry", () => {
    const s0 = createInitialState();
    s0.queue = [
      { queueNonce: "opt", text: "a", state: "optimistic", source: "dashboard", createdAt: TS },
      { queueNonce: "fail", text: "b", state: "failed", source: "dashboard", createdAt: TS },
    ];
    const s1 = removeQueueEntry(s0, "opt");
    expect(s1.queue.map((q) => q.queueNonce)).toEqual(["fail"]);
    const s2 = removeQueueEntry(s1, "fail");
    expect(s2.queue).toHaveLength(0);
  });

  it("removeQueueEntry REFUSES to remove a confirmed entry (honest-removal contract)", () => {
    const s0 = createInitialState();
    s0.queue = [{ queueNonce: "c", text: "in pi's real queue", state: "confirmed", source: "dashboard", createdAt: TS }];
    const s1 = removeQueueEntry(s0, "c");
    expect(s1).toBe(s0);
    expect(s1.queue).toHaveLength(1);
  });
});

describe("event-reducer queue: degenerate single-slot path unchanged", () => {
  it("queue events do not touch pendingPrompt; pendingPrompt cleared by user message_start as before", () => {
    const s0 = createInitialState();
    s0.pendingPrompt = { text: "immediate send", images: undefined };
    // A queue_state arriving while pendingPrompt is set must not disturb it.
    const s1 = reduceEvent(s0, ev("queue_state", {
      followUp: [], steeringCount: 0, pendingMessageCount: 0, source: "lifecycle",
    }));
    expect(s1.pendingPrompt).toEqual({ text: "immediate send", images: undefined });
    // The user message_start (no queueNonce) still clears pendingPrompt — original contract.
    const s2 = reduceEvent(s1, ev("message_start", {
      message: { role: "user", content: [{ type: "text", text: "immediate send" }] },
      nonce: "n",
    }));
    expect(s2.pendingPrompt).toBeUndefined();
    expect(s2.queue).toHaveLength(0);
  });

  it("createInitialState seeds an empty queue", () => {
    expect(createInitialState().queue).toEqual([]);
  });
});
