/**
 * Surface B — (author,text) reconciliation red-arms (client reducer).
 *
 * These EMPIRICALLY RUN the real `reduceEvent` (not code-reasoned): they drive
 * the reducer with two operators' events and assert per-author reconciliation.
 *
 *  #1 two-same-text-senders — both operators send IDENTICAL text; each
 *     operator's optimistic card reconciles to ITS OWN nonce, and op-2's
 *     confirmation NEVER re-keys op-1's same-text card (no cross-author adopt).
 *  #2 2-authed-browsers-on-1-session — per-author reconciliation holds with
 *     both principals' events interleaved; no state corruption.
 *  #3 flag-off byte-unchanged — with NO author (single-operator), the match is
 *     text-only (today's behavior): a same-text confirmation still adopts.
 *
 * Red-arm: revert `findSoleOptimisticByText` to text-only sole-match (drop the
 * author scope) → op-2's confirmation re-keys op-1's card → #1/#2 FAIL. Make
 * the per-author refusal engage when author is absent → #3 FAILS.
 */
import { describe, it, expect } from "vitest";
import {
  createInitialState,
  reduceEvent,
  findSoleOptimisticByText,
  type SessionState,
} from "../event-reducer.js";
import type { DashboardEvent, MessageAuthor } from "@blackbelt-technology/pi-dashboard-shared/types.js";

const TS = 1777032001000;
const OP1: MessageAuthor = { sub: "op1@example.com", display: "Op One" };
const OP2: MessageAuthor = { sub: "op2@example.com", display: "Op Two" };

function ev(eventType: string, data: Record<string, unknown>): DashboardEvent {
  return { eventType, timestamp: TS, data } as DashboardEvent;
}

/** Client optimistic cards are AUTHOR-LESS at creation (client can't know its
 *  own server-derived author — anti-spoof). Model that exactly. */
function optimistic(queueNonce: string, text: string): SessionState["queue"][number] {
  return { queueNonce, text, state: "optimistic", source: "dashboard", createdAt: TS - 1000 };
}

describe("Surface B #1 — two same-text senders reconcile per-author (EMPIRICALLY RUN)", () => {
  it("op-2's confirmation does NOT re-key op-1's same-text optimistic card", () => {
    // op-1's client: it has op-1's own optimistic card "deploy" (nonce n-op1).
    // op-2 also sent "deploy" (nonce n-op2). op-2's message_enqueued broadcasts
    // to op-1's client. Exact-nonce fails (op-1's client has no n-op2), so the
    // text-fallback runs — and MUST refuse to adopt op-1's card.
    const s0 = createInitialState();
    s0.queue = [optimistic("n-op1", "deploy")];

    const s1 = reduceEvent(s0, ev("message_enqueued", {
      queueNonce: "n-op2", text: "deploy", source: "dashboard", author: OP2,
    }));

    // THE INVARIANT: op-1's card is UNTOUCHED — still optimistic, still keyed
    // n-op1, never re-keyed onto op-2's nonce (no cross-author adoption).
    const op1Card = s1.queue.find((q) => q.queueNonce === "n-op1");
    expect(op1Card).toBeDefined();
    expect(op1Card!.state).toBe("optimistic");
    expect(op1Card!.queueNonce).toBe("n-op1");
    // op-2's dashboard confirmation is NOT appended here either: the anti-
    // doubling guard (source dashboard + same-text optimistic present) drops it
    // on THIS client — op-2's card surfaces on op-2's OWN client / when it
    // commits. The point is op-1 never lost its card. So the queue is unchanged.
    expect(s1.queue).toHaveLength(1);
    expect(s1.queue.some((q) => q.queueNonce === "n-op2" && q.state === "confirmed")).toBe(false);
  });

  it("op-1's OWN confirmation reconciles op-1's card by exact nonce (baseline)", () => {
    const s0 = createInitialState();
    s0.queue = [optimistic("n-op1", "deploy")];
    const s1 = reduceEvent(s0, ev("message_enqueued", {
      queueNonce: "n-op1", text: "deploy", source: "dashboard", author: OP1,
    }));
    expect(s1.queue).toHaveLength(1);
    expect(s1.queue[0].state).toBe("confirmed");
    expect(s1.queue[0].author?.sub).toBe("op1@example.com");
  });
});

describe("Surface B #2 — 2 authed browsers on 1 session: per-author, no corruption", () => {
  it("interleaved op-1/op-2 same-text sends keep each card keyed to its own nonce", () => {
    // On op-1's client: op-1's optimistic "status" (n-a). op-2 also sends
    // "status" (n-b); op-2's confirmation reaches op-1's client.
    let s = createInitialState();
    s.queue = [optimistic("n-a", "status")];

    // op-2 confirms "status" (their nonce n-b) → must NOT adopt op-1's card.
    s = reduceEvent(s, ev("message_enqueued", { queueNonce: "n-b", text: "status", source: "dashboard", author: OP2 }));
    expect(s.queue.find((q) => q.queueNonce === "n-a")!.state).toBe("optimistic");
    // op-1's card was NOT re-keyed to n-b.
    expect(s.queue.find((q) => q.queueNonce === "n-a")!.queueNonce).toBe("n-a");

    // op-1 confirms their OWN "status" (n-a) → exact-nonce reconciles.
    s = reduceEvent(s, ev("message_enqueued", { queueNonce: "n-a", text: "status", source: "dashboard", author: OP1 }));
    const a = s.queue.find((q) => q.queueNonce === "n-a")!;
    expect(a.state).toBe("confirmed");
    expect(a.author?.sub).toBe("op1@example.com");
    // No corruption: op-1's card is confirmed + correctly authored, never
    // cross-adopted onto op-2's identity.
    expect(a.author?.sub).not.toBe("op2@example.com");
  });

  it("message_start(author) also refuses cross-author text adoption", () => {
    // op-1's client holds op-1's optimistic "ship it". op-2's committing user
    // message_start (author op-2, no matching nonce on this client) must not
    // grab op-1's card via the text-fallback.
    const s0 = createInitialState();
    s0.queue = [optimistic("n-op1", "ship it")];
    const s1 = reduceEvent(s0, ev("message_start", {
      message: { role: "user", content: "ship it" },
      author: OP2, // op-2 authored this committing turn
    }));
    // op-1's optimistic card is untouched (not removed by op-2's text).
    expect(s1.queue.find((q) => q.queueNonce === "n-op1")?.state).toBe("optimistic");
    // The committed bubble renders with op-2's author (immediate-0-queue path).
    const bubble = s1.messages[s1.messages.length - 1];
    expect(bubble.role).toBe("user");
    expect(bubble.author?.sub).toBe("op2@example.com");
  });
});

describe("Surface B #3 — flag-off byte-unchanged (no author → text-only match)", () => {
  it("single-operator: a same-text confirmation with NO author still adopts (today)", () => {
    const s0 = createInitialState();
    s0.queue = [optimistic("n-1", "single op text")];
    // Flag-off confirmation carries NO author.
    const s1 = reduceEvent(s0, ev("message_enqueued", {
      queueNonce: "n-bridge", text: "single op text", source: "dashboard",
    }));
    // Text-only fallback re-keys the sole optimistic onto the bridge nonce
    // (byte-identical to pre-Surface-B behavior).
    expect(s1.queue).toHaveLength(1);
    expect(s1.queue[0].state).toBe("confirmed");
    expect(s1.queue[0].queueNonce).toBe("n-bridge");
  });

  it("findSoleOptimisticByText degrades to text-only when author is undefined", () => {
    const queue = [optimistic("n-1", "same")];
    // No author arg → text-only → finds the sole match.
    expect(findSoleOptimisticByText(queue, "same")).toBe(0);
    // With a DIFFERENT author present and an author-less card → refuse.
    expect(findSoleOptimisticByText(queue, "same", OP2)).toBe(-1);
  });

  it("preserves count-of-1 conservatism PER-AUTHOR (>1 same-(author,text) → -1)", () => {
    const queue = [
      { queueNonce: "a", text: "dup", state: "optimistic" as const, source: "dashboard" as const, author: OP1, createdAt: TS },
      { queueNonce: "b", text: "dup", state: "optimistic" as const, source: "dashboard" as const, author: OP1, createdAt: TS },
    ];
    // Two same-(author,text) optimistics → do NOT guess (nonce-swap seam stays
    // closed, now per-author).
    expect(findSoleOptimisticByText(queue, "dup", OP1)).toBe(-1);
  });
});
