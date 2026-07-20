/**
 * Tests for the message-lane builder (`thread-message-lane`) — the read-path
 * THROUGH the P1 cloned-DTO facade.
 *
 * The load-bearing guarantees:
 *  1. The lane reads THROUGH `createClonedSessionFacade` (frozen DTOs) — a
 *     mutation of a facade-returned entry can never reach the fixture manager's
 *     internals (the P1 additive-safety seam).
 *  2. `thread_delivery` custom_message rows SURVIVE into the lane (normalized to
 *     narrative rows the committed replay understands) — never silently dropped.
 *  3. Native committed ORDER is preserved (no reorder).
 */
import { describe, it, expect } from "vitest";
import {
  buildMessageLaneStateFromManager,
  buildMessageLaneStateFromEntries,
  normalizeThreadEntries,
} from "../thread-message-lane.js";
import { createClonedSessionFacade, type SessionEntryDto } from "@blackbelt-technology/pi-dashboard-shared/thread-durability/tier1/cloned-session-facade.js";
import { seedDeliveredManager, SEED_THREAD_DELIVERED } from "../tier1-threads-seed.js";

describe("thread-message-lane — reads THROUGH the P1 facade", () => {
  it("builds a settled (non-streaming) SessionState from the fixture manager", () => {
    const state = buildMessageLaneStateFromManager(seedDeliveredManager(), SEED_THREAD_DELIVERED);
    expect(state.isStreaming).toBe(false);
    expect(state.status).toBe("ended");
    expect(state.messages.length).toBeGreaterThan(0);
  });

  it("reads frozen DTOs from the facade (the additive-safety seam holds)", () => {
    const facade = createClonedSessionFacade(seedDeliveredManager());
    const entries = facade.getEntries();
    // Deep-frozen: a mutation attempt throws in strict mode / is a no-op.
    expect(Object.isFrozen(entries[0])).toBe(true);
  });

  it("surfaces the thread_delivery provenance row (never dropped)", () => {
    const state = buildMessageLaneStateFromManager(seedDeliveredManager(), SEED_THREAD_DELIVERED);
    const joined = state.messages.map((m) => m.content).join("\n");
    // The normalizer labels the delivery row; its delivery_id must be present.
    expect(joined).toContain("thread_delivery");
    expect(joined).toContain("dlv-onb-0001");
  });

  it("keeps the 3 identical tool calls as DISTINCT rows (M11 — no grouping in the builder)", () => {
    const state = buildMessageLaneStateFromManager(seedDeliveredManager(), SEED_THREAD_DELIVERED);
    // Three bash toolResult rows (curl health poll) survive individually — the
    // builder never groups; grouping is disabled at the ChatView render site too.
    const toolRows = state.messages.filter((m) => m.role === "toolResult" && m.toolName === "bash");
    expect(toolRows.length).toBe(3);
  });
});

describe("normalizeThreadEntries — pure normalization", () => {
  it("maps a custom_message/thread_delivery entry to a user-role message, preserving order", () => {
    const entries: SessionEntryDto[] = [
      { type: "message", id: "m1", parentId: null, timestamp: "t1", message: { role: "user", content: "hi" } } as unknown as SessionEntryDto,
      {
        type: "custom_message",
        customType: "thread_delivery",
        id: "d1",
        parentId: "m1",
        timestamp: "t2",
        display: "delivery envelope",
        details: { delivery_id: "dlv-x", thread_id: "th", attempt: 2 },
      } as unknown as SessionEntryDto,
    ];
    const out = normalizeThreadEntries(entries) as Array<{ type: string; id: string; message?: { role: string; content: string } }>;
    expect(out).toHaveLength(2); // 1:1 — nothing dropped
    expect(out[0].id).toBe("m1"); // order preserved
    expect(out[1].id).toBe("d1");
    expect(out[1].type).toBe("message"); // normalized to a replayable message
    expect(out[1].message?.role).toBe("user");
    expect(out[1].message?.content).toContain("dlv-x");
    expect(out[1].message?.content).toContain("delivery envelope");
  });

  it("passes ordinary message entries through unchanged (by value)", () => {
    const entries: SessionEntryDto[] = [
      { type: "message", id: "m1", parentId: null, timestamp: "t1", message: { role: "assistant", content: "done" } } as unknown as SessionEntryDto,
    ];
    const out = normalizeThreadEntries(entries) as Array<{ id: string; type: string }>;
    expect(out[0].id).toBe("m1");
    expect(out[0].type).toBe("message");
  });

  it("builds an empty settled state from zero entries", () => {
    const state = buildMessageLaneStateFromEntries([], "empty-thread");
    expect(state.messages).toHaveLength(0);
    expect(state.isStreaming).toBe(false);
  });
});
