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

describe("event-reducer queue: AMEND #5 queue_state authoritative-supersede (F4)", () => {
  it("NO-DUP: two same-text optimistics + MISMATCHED-nonce snapshot of two → length 2 (supersede, not preserve)", () => {
    // The F4 repro. Pre-fix this produced [bridge1, bridge2, o1, o2] = 4 cards.
    const s0 = createInitialState();
    s0.queue = [
      { queueNonce: "o1", text: "same", state: "optimistic", source: "dashboard", createdAt: TS },
      { queueNonce: "o2", text: "same", state: "optimistic", source: "dashboard", createdAt: TS + 1 },
    ];
    const s1 = reduceEvent(s0, ev("queue_state", {
      followUp: [
        { queueNonce: "bridge1", text: "same" },
        { queueNonce: "bridge2", text: "same" },
      ],
      steeringCount: 0,
      pendingMessageCount: 2,
      source: "lifecycle",
    }));
    // Both same-text optimistics are SUPERSEDED by the two snapshot confirmeds.
    expect(s1.queue).toHaveLength(2);
    expect(s1.queue.map((q) => q.queueNonce)).toEqual(["bridge1", "bridge2"]);
    expect(s1.queue.every((q) => q.state === "confirmed")).toBe(true);
  });

  it("PARTIAL: two same-text optimistics + snapshot of ONE → length 2 (oldest superseded, newer preserved)", () => {
    const s0 = createInitialState();
    s0.queue = [
      { queueNonce: "o1", text: "same", state: "optimistic", source: "dashboard", createdAt: TS },
      { queueNonce: "o2", text: "same", state: "optimistic", source: "dashboard", createdAt: TS + 1 },
    ];
    const s1 = reduceEvent(s0, ev("queue_state", {
      followUp: [{ queueNonce: "bridge1", text: "same" }],
      steeringCount: 0,
      pendingMessageCount: 1,
      source: "lifecycle",
    }));
    // One slot supersedes the FIFO-oldest (o1); o2 (newer) preserved.
    expect(s1.queue).toHaveLength(2);
    expect(s1.queue[0].queueNonce).toBe("bridge1");
    expect(s1.queue[0].state).toBe("confirmed");
    expect(s1.queue[1].queueNonce).toBe("o2");
    expect(s1.queue[1].state).toBe("optimistic");
  });

  it("EXACT-NONCE still wins: snapshot carrying a client's exact nonce adopts it (no text supersede needed, no dup)", () => {
    const s0 = createInitialState();
    s0.queue = [
      { queueNonce: "o1", text: "same", state: "optimistic", source: "dashboard", createdAt: TS },
      { queueNonce: "o2", text: "same", state: "optimistic", source: "dashboard", createdAt: TS + 1 },
    ];
    // Snapshot confirms o1 by its EXACT nonce + a second bridge-nonce for o2's text.
    const s1 = reduceEvent(s0, ev("queue_state", {
      followUp: [
        { queueNonce: "o1", text: "same" },
        { queueNonce: "bridge2", text: "same" },
      ],
      steeringCount: 0,
      pendingMessageCount: 2,
      source: "lifecycle",
    }));
    expect(s1.queue).toHaveLength(2);
    // o1 adopted by exact nonce (inherits createdAt); bridge2 supersedes o2 by text.
    expect(s1.queue[0].queueNonce).toBe("o1");
    expect(s1.queue[0].createdAt).toBe(TS); // identity inherited
    expect(s1.queue[1].queueNonce).toBe("bridge2");
    expect(s1.queue.every((q) => q.state === "confirmed")).toBe(true);
  });

  it("DISTINCT-TEXT untouched: a same-text snapshot confirmed must NOT supersede a different-text optimistic", () => {
    const s0 = createInitialState();
    s0.queue = [
      { queueNonce: "o-other", text: "different", state: "optimistic", source: "dashboard", createdAt: TS },
    ];
    const s1 = reduceEvent(s0, ev("queue_state", {
      followUp: [{ queueNonce: "bridge1", text: "same" }],
      steeringCount: 0,
      pendingMessageCount: 1,
      source: "lifecycle",
    }));
    // "same" slot does not match "different" → o-other preserved alongside the confirmed.
    expect(s1.queue).toHaveLength(2);
    expect(s1.queue[0].queueNonce).toBe("bridge1");
    expect(s1.queue[0].state).toBe("confirmed");
    expect(s1.queue[1].queueNonce).toBe("o-other");
    expect(s1.queue[1].state).toBe("optimistic");
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

describe("event-reducer queue: AMEND #3 same-text reconciliation (FIFO-oldest + single-match)", () => {
  /** Two genuine same-text optimistic entries, distinct nonces, FIFO order o1→o2. */
  function stateWithTwoSameText(): SessionState {
    const s = createInitialState();
    s.queue = [
      { queueNonce: "o1", text: "same text", state: "optimistic", source: "dashboard", createdAt: TS },
      { queueNonce: "o2", text: "same text", state: "optimistic", source: "dashboard", createdAt: TS + 1 },
    ];
    return s;
  }

  it("exact-nonce match still wins over the text fallback (no mis-adopt)", () => {
    const s0 = stateWithTwoSameText();
    // A confirmation carrying o2's exact nonce must confirm o2 — NOT the oldest.
    const s1 = reduceEvent(s0, ev("message_enqueued", {
      queueNonce: "o2", text: "same text", source: "dashboard",
    }));
    const o2 = s1.queue.find((q) => q.queueNonce === "o2")!;
    const o1 = s1.queue.find((q) => q.queueNonce === "o1")!;
    expect(o2.state).toBe("confirmed");
    expect(o1.state).toBe("optimistic");
  });

  it("SINGLE same-text optimistic: an UNMATCHED-nonce message_enqueued adopts THAT one (FIFO-oldest, re-keyed)", () => {
    // One same-text optimistic among a differently-texted sibling. The
    // text-fallback fires (exactly one match) and adopts the bridge nonce.
    const s = createInitialState();
    s.queue = [
      { queueNonce: "other", text: "different", state: "optimistic", source: "dashboard", createdAt: TS },
      { queueNonce: "o1", text: "target text", state: "optimistic", source: "dashboard", createdAt: TS + 1 },
    ];
    const s1 = reduceEvent(s, ev("message_enqueued", {
      queueNonce: "bridge-x", text: "target text", source: "dashboard",
    }));
    expect(s1.queue).toHaveLength(2); // adopted, NOT appended
    const adopted = s1.queue.find((q) => q.queueNonce === "bridge-x")!;
    expect(adopted.state).toBe("confirmed");
    expect(adopted.createdAt).toBe(TS + 1); // identity preserved = the OLD o1 entry
    expect(s1.queue.find((q) => q.queueNonce === "other")!.state).toBe("optimistic");
  });

  it("SINGLE same-text optimistic: a nonce-less message_start commit removes THAT one (FIFO-oldest)", () => {
    const s = createInitialState();
    s.queue = [
      { queueNonce: "other", text: "different", state: "optimistic", source: "dashboard", createdAt: TS },
      { queueNonce: "o1", text: "target text", state: "optimistic", source: "dashboard", createdAt: TS + 1 },
    ];
    const s1 = reduceEvent(s, ev("message_start", {
      message: { role: "user", content: [{ type: "text", text: "target text" }] },
      nonce: "n-a",
    }));
    // The single same-text match (o1) removed; the differently-texted sibling stays.
    expect(s1.queue.map((q) => q.queueNonce)).toEqual(["other"]);
  });

  it("MULTIPLE same-text + UNMATCHED DASHBOARD message_enqueued → does NOT adopt NOR append (waits, queue stays exactly 2)", () => {
    const s0 = stateWithTwoSameText();
    const s1 = reduceEvent(s0, ev("message_enqueued", {
      queueNonce: "no-match", text: "same text", source: "dashboard",
    }));
    // AMEND #4 F3: two same-text optimistics → findSoleOptimisticByText returns
    // -1 (no adopt — a guess would swap nonces). The append branch is
    // SOURCE-AWARE: a dashboard confirmation with an ambiguous same-text
    // optimistic must NOT append a 3rd card (that re-opened the doubling bug).
    // Queue stays EXACTLY the original two optimistics; send-order nonces intact.
    expect(s1.queue).toHaveLength(2);
    expect(s1.queue.map((q) => q.queueNonce)).toEqual(["o1", "o2"]);
    expect(s1.queue.every((q) => q.state === "optimistic")).toBe(true);
  });

  it("TUI-origin same-text message_enqueued still appends a fresh card (legitimate separate origin)", () => {
    // A TUI-typed message with the same text as a dashboard optimistic is a
    // genuinely separate card — the bridge minted its nonce, there is no client
    // optimistic to reconcile. It MUST still append.
    const s0 = stateWithTwoSameText();
    const s1 = reduceEvent(s0, ev("message_enqueued", {
      queueNonce: "tui-x", text: "same text", source: "tui",
    }));
    expect(s1.queue).toHaveLength(3);
    const appended = s1.queue.find((q) => q.queueNonce === "tui-x")!;
    expect(appended.state).toBe("confirmed");
    expect(appended.source).toBe("tui");
    // The two dashboard optimistics are untouched.
    expect(s1.queue.filter((q) => q.state === "optimistic").map((q) => q.queueNonce)).toEqual(["o1", "o2"]);
  });

  it("DASHBOARD message_enqueued with NO same-text optimistic still appends (genuinely-new, e.g. optimistic already cleared)", () => {
    // source dashboard but the optimistic card is gone (cleared/failed) → there
    // is genuinely nothing to reconcile, so appending is correct (not a dup).
    const s = createInitialState();
    s.queue = [
      { queueNonce: "other", text: "different", state: "confirmed", source: "dashboard", createdAt: TS },
    ];
    const s1 = reduceEvent(s, ev("message_enqueued", {
      queueNonce: "fresh", text: "brand new text", source: "dashboard",
    }));
    expect(s1.queue).toHaveLength(2);
    expect(s1.queue.find((q) => q.queueNonce === "fresh")!.state).toBe("confirmed");
  });

  it("MULTIPLE same-text + nonce-less message_start → does NOT remove either (waits)", () => {
    const s0 = stateWithTwoSameText();
    const s1 = reduceEvent(s0, ev("message_start", {
      message: { role: "user", content: [{ type: "text", text: "same text" }] },
      nonce: "n-ambiguous",
    }));
    // Ambiguous → neither optimistic removed (both still queued, send-order intact).
    expect(s1.queue.map((q) => q.queueNonce)).toEqual(["o1", "o2"]);
  });

  it("REPLY-LINKAGE (Bert dl-2691 falsifiable criterion): two same-text sends dispatch in send-order so replies thread to the correct card", () => {
    // Two genuine same-text sends, confirmed by their EXACT nonces (the normal
    // dashboard round-trip: client mints o1 then o2; bridge reuses each).
    let s: SessionState = stateWithTwoSameText();
    s = reduceEvent(s, ev("message_enqueued", { queueNonce: "o1", text: "same text", source: "dashboard" }));
    s = reduceEvent(s, ev("message_enqueued", { queueNonce: "o2", text: "same text", source: "dashboard" }));
    expect(s.queue.map((q) => q.queueNonce)).toEqual(["o1", "o2"]); // send-order intact, NOT swapped

    // pi pulls them into work FIFO: o1 first. Its message_start carries o1 +
    // a per-message nonce "n1"; the user bubble lands, then its reply.
    s = reduceEvent(s, ev("message_start", {
      message: { role: "user", content: [{ type: "text", text: "same text" }] },
      queueNonce: "o1", nonce: "n1",
    }));
    // assistant reply #1 (distinct text) threads positionally after o1's bubble.
    s = reduceEvent(s, ev("message_start", { message: { role: "assistant", content: [] }, nonce: "r1" }));
    s = reduceEvent(s, ev("message_update", { message: { role: "assistant", content: [{ type: "text", text: "REPLY-ONE" }] } }));
    s = reduceEvent(s, ev("message_end", { message: { role: "assistant", content: [{ type: "text", text: "REPLY-ONE" }] }, nonce: "r1", entryId: "e-r1" }));

    // Then o2 dispatches; its reply follows.
    s = reduceEvent(s, ev("message_start", {
      message: { role: "user", content: [{ type: "text", text: "same text" }] },
      queueNonce: "o2", nonce: "n2",
    }));
    s = reduceEvent(s, ev("message_start", { message: { role: "assistant", content: [] }, nonce: "r2" }));
    s = reduceEvent(s, ev("message_update", { message: { role: "assistant", content: [{ type: "text", text: "REPLY-TWO" }] } }));
    s = reduceEvent(s, ev("message_end", { message: { role: "assistant", content: [{ type: "text", text: "REPLY-TWO" }] }, nonce: "r2", entryId: "e-r2" }));

    // Reply-linkage = positional thread in messages[]. The first user bubble is
    // immediately followed by REPLY-ONE; the second by REPLY-TWO. A nonce-swap
    // would have dispatched o2's card first → replies under the wrong bubble.
    const roles = s.messages.map((m) => `${m.role}:${m.content}`);
    const firstUser = roles.indexOf("user:same text");
    const secondUser = roles.indexOf("user:same text", firstUser + 1);
    expect(firstUser).toBeGreaterThanOrEqual(0);
    expect(secondUser).toBeGreaterThan(firstUser);
    // The reply right after the first user bubble is REPLY-ONE, after the second is REPLY-TWO.
    expect(roles[firstUser + 1]).toBe("assistant:REPLY-ONE");
    expect(roles[secondUser + 1]).toBe("assistant:REPLY-TWO");
    // Queue fully drained.
    expect(s.queue).toHaveLength(0);
  });
});

describe("event-reducer queue: AMEND #5 (f) retry idempotency-guard (stale OLD confirmation inert)", () => {
  /**
   * Models the post-retry state: a failed card was re-keyed OLD→NEW (now
   * optimistic) and the OLD nonce recorded as retry-superseded. A connected-slow
   * OLD send then confirms LATE — as each of the 3 reducer surfaces — and must
   * be INERT: no flip-flop back to OLD, no duplicate card, no second dispatch.
   */
  function statePostRetry(): SessionState {
    const s = createInitialState();
    s.queue = [
      { queueNonce: "NEW", text: "retry me", state: "optimistic", source: "dashboard", createdAt: TS + 100 },
    ];
    s.supersededNonces = new Set(["OLD"]);
    return s;
  }

  it("late OLD message_enqueued is inert (no flip-flop, no duplicate)", () => {
    const s0 = statePostRetry();
    const s1 = reduceEvent(s0, ev("message_enqueued", {
      queueNonce: "OLD", text: "retry me", source: "dashboard",
    }));
    // Card unchanged: still the single NEW optimistic. OLD neither adopted,
    // re-keyed onto NEW, nor appended.
    expect(s1.queue).toHaveLength(1);
    expect(s1.queue[0].queueNonce).toBe("NEW");
    expect(s1.queue[0].state).toBe("optimistic");
  });

  it("late OLD queue_state snapshot entry is inert (no ghost confirmed, no NEW supersede)", () => {
    const s0 = statePostRetry();
    // The bridge's reconstructed snapshot still lists the OLD ghost (same text).
    const s1 = reduceEvent(s0, ev("queue_state", {
      followUp: [{ queueNonce: "OLD", text: "retry me" }],
      steeringCount: 0,
      pendingMessageCount: 1,
      source: "lifecycle",
    }));
    // OLD filtered out → no confirmed card built, no same-text slot to claim
    // NEW. NEW preserved as the sole optimistic.
    expect(s1.queue).toHaveLength(1);
    expect(s1.queue[0].queueNonce).toBe("NEW");
    expect(s1.queue[0].state).toBe("optimistic");
  });

  it("late OLD message_start dispatch is inert (no removal of NEW, no flip-flop via text)", () => {
    const s0 = statePostRetry();
    const s1 = reduceEvent(s0, ev("message_start", {
      message: { role: "user", content: [{ type: "text", text: "retry me" }] },
      queueNonce: "OLD",
      nonce: "n-old",
    }));
    // The committed user bubble renders (pi did commit the OLD send — the
    // honest-disclosed pi-side double), but the NEW card is untouched: not
    // removed by OLD's nonce, and OLD's text did NOT grab NEW via the fallback.
    expect(s1.queue).toHaveLength(1);
    expect(s1.queue[0].queueNonce).toBe("NEW");
    expect(s1.queue[0].state).toBe("optimistic");
    const lastUser = s1.messages.filter((m) => m.role === "user").pop();
    expect(lastUser?.content).toBe("retry me");
  });

  it("the NEW (non-superseded) confirmation still reconciles correctly (no over-suppression)", () => {
    const s0 = statePostRetry();
    const s1 = reduceEvent(s0, ev("message_enqueued", {
      queueNonce: "NEW", text: "retry me", source: "dashboard",
    }));
    expect(s1.queue).toHaveLength(1);
    expect(s1.queue[0].queueNonce).toBe("NEW");
    expect(s1.queue[0].state).toBe("confirmed");
  });

  it("full sequence: NEW confirms, then OLD ghost-dispatches → still exactly the NEW card lifecycle, no duplicate", () => {
    let s: SessionState = statePostRetry();
    // NEW confirms.
    s = reduceEvent(s, ev("message_enqueued", { queueNonce: "NEW", text: "retry me", source: "dashboard" }));
    expect(s.queue.map((q) => q.queueNonce)).toEqual(["NEW"]);
    // OLD ghost commits first in pi FIFO (it was enqueued earlier) — inert, no
    // second card removed, NEW survives.
    s = reduceEvent(s, ev("message_start", {
      message: { role: "user", content: [{ type: "text", text: "retry me" }] },
      queueNonce: "OLD", nonce: "n-old",
    }));
    expect(s.queue.map((q) => q.queueNonce)).toEqual(["NEW"]);
    // Then NEW genuinely dispatches → card removed, queue drained.
    s = reduceEvent(s, ev("message_start", {
      message: { role: "user", content: [{ type: "text", text: "retry me" }] },
      queueNonce: "NEW", nonce: "n-new",
    }));
    expect(s.queue).toHaveLength(0);
  });
});
