import { describe, it, expect } from "vitest";
import { createMemoryEventStore } from "../memory-event-store.js";
import type { DashboardEvent } from "@blackbelt-technology/pi-dashboard-shared/types.js";

function makeEvent(type: string = "test"): DashboardEvent {
  return { eventType: type, timestamp: Date.now(), data: {} };
}

describe("memory-event-store", () => {
  const neverPinned = () => false;

  it("inserts and retrieves events", () => {
    const store = createMemoryEventStore(neverPinned);
    const seq1 = store.insertEvent("s1", makeEvent("a"));
    const seq2 = store.insertEvent("s1", makeEvent("b"));
    expect(seq1).toBe(1);
    expect(seq2).toBe(2);

    const events = store.getEvents("s1", 1);
    expect(events).toHaveLength(2);
    expect(events[0].seq).toBe(1);
    expect(events[1].seq).toBe(2);
  });

  it("getEvents with minSeq filters correctly", () => {
    const store = createMemoryEventStore(neverPinned);
    store.insertEvent("s1", makeEvent());
    store.insertEvent("s1", makeEvent());
    store.insertEvent("s1", makeEvent());

    const events = store.getEvents("s1", 2);
    expect(events).toHaveLength(2);
    expect(events[0].seq).toBe(2);
  });

  it("getEvents returns empty for unknown session", () => {
    const store = createMemoryEventStore(neverPinned);
    expect(store.getEvents("unknown", 1)).toEqual([]);
  });

  it("getEvent retrieves single event", () => {
    const store = createMemoryEventStore(neverPinned);
    const evt = makeEvent("special");
    store.insertEvent("s1", evt);
    const result = store.getEvent("s1", 1);
    expect(result?.eventType).toBe("special");
  });

  it("getEvent returns undefined for missing", () => {
    const store = createMemoryEventStore(neverPinned);
    expect(store.getEvent("s1", 1)).toBeUndefined();
  });

  it("deleteEventsForSession clears buffer", () => {
    const store = createMemoryEventStore(neverPinned);
    store.insertEvent("s1", makeEvent());
    store.insertEvent("s1", makeEvent());
    const deleted = store.deleteEventsForSession("s1");
    expect(deleted).toBe(2);
    expect(store.getEvents("s1", 1)).toEqual([]);
    expect(store.hasEvents("s1")).toBe(false);
  });

  it("deleteEventsForSession returns 0 for unknown session", () => {
    const store = createMemoryEventStore(neverPinned);
    expect(store.deleteEventsForSession("unknown")).toBe(0);
  });

  it("hasEvents checks correctly", () => {
    const store = createMemoryEventStore(neverPinned);
    expect(store.hasEvents("s1")).toBe(false);
    store.insertEvent("s1", makeEvent());
    expect(store.hasEvents("s1")).toBe(true);
  });

  it("sessionCount tracks number of sessions", () => {
    const store = createMemoryEventStore(neverPinned);
    expect(store.sessionCount()).toBe(0);
    store.insertEvent("s1", makeEvent());
    store.insertEvent("s2", makeEvent());
    expect(store.sessionCount()).toBe(2);
  });

  it("assigns new seq numbers after deleteEventsForSession", () => {
    const store = createMemoryEventStore(neverPinned);
    store.insertEvent("s1", makeEvent());
    store.insertEvent("s1", makeEvent());
    store.deleteEventsForSession("s1");
    const seq = store.insertEvent("s1", makeEvent());
    expect(seq).toBe(1); // Resets after delete
  });

  describe("LRU eviction", () => {
    it("evicts least-recently-accessed when over limit", () => {
      const store = createMemoryEventStore(neverPinned, 3);
      store.insertEvent("s1", makeEvent());
      store.insertEvent("s2", makeEvent());
      store.insertEvent("s3", makeEvent());
      expect(store.sessionCount()).toBe(3);

      // s4 should cause eviction of s1 (oldest)
      store.insertEvent("s4", makeEvent());
      expect(store.sessionCount()).toBe(3);
      expect(store.hasEvents("s1")).toBe(false);
      expect(store.hasEvents("s4")).toBe(true);
    });

    it("skips pinned sessions during eviction", () => {
      const pinned = new Set(["s1"]);
      const store = createMemoryEventStore((id) => pinned.has(id), 3);
      store.insertEvent("s1", makeEvent());
      store.insertEvent("s2", makeEvent());
      store.insertEvent("s3", makeEvent());

      // s4 should cause eviction of s2 (s1 is pinned)
      store.insertEvent("s4", makeEvent());
      expect(store.hasEvents("s1")).toBe(true); // pinned, not evicted
      expect(store.hasEvents("s2")).toBe(false); // evicted
    });

    it("does not evict when all sessions are pinned", () => {
      const store = createMemoryEventStore(() => true, 2);
      store.insertEvent("s1", makeEvent());
      store.insertEvent("s2", makeEvent());
      store.insertEvent("s3", makeEvent());
      // All pinned — can't evict, so size exceeds limit
      expect(store.sessionCount()).toBe(3);
    });

    it("accessing events updates lastAccess to prevent eviction", async () => {
      const store = createMemoryEventStore(neverPinned, 3);
      store.insertEvent("s1", makeEvent());
      await new Promise((r) => setTimeout(r, 5));
      store.insertEvent("s2", makeEvent());
      await new Promise((r) => setTimeout(r, 5));
      store.insertEvent("s3", makeEvent());

      // Access s1 so it becomes most recent
      await new Promise((r) => setTimeout(r, 5));
      store.getEvents("s1", 1);

      // s4 should evict s2 (least recently accessed), not s1
      store.insertEvent("s4", makeEvent());
      expect(store.hasEvents("s1")).toBe(true);
      expect(store.hasEvents("s2")).toBe(false);
    });
  });

  describe("image data preservation", () => {
    it("preserves base64 image data when sibling mimeType exists", () => {
      // maxStringFieldSize = 100 so normal strings get truncated
      const store = createMemoryEventStore(neverPinned, 100, 5000, 100);
      const longBase64 = "A".repeat(500);
      const event: DashboardEvent = {
        eventType: "message_start",
        timestamp: Date.now(),
        data: {
          message: {
            role: "user",
            content: [
              { type: "image", data: longBase64, mimeType: "image/png" },
            ],
          },
        },
      };
      store.insertEvent("s1", event);
      const stored = store.getEvent("s1", 1);
      const content = (stored as any).data.message.content[0];
      expect(content.data).toBe(longBase64);
      expect(content.data).toHaveLength(500);
    });

    it("still truncates data field without mimeType sibling", () => {
      const store = createMemoryEventStore(neverPinned, 100, 5000, 100);
      const longString = "B".repeat(500);
      const event: DashboardEvent = {
        eventType: "test",
        timestamp: Date.now(),
        data: { payload: { data: longString } },
      };
      store.insertEvent("s1", event);
      const stored = store.getEvent("s1", 1);
      const val = (stored as any).data.payload.data as string;
      expect(val.length).toBeLessThan(500);
      expect(val).toContain("truncated");
    });

    it("truncates other fields alongside preserved image data", () => {
      const store = createMemoryEventStore(neverPinned, 100, 5000, 100);
      const longBase64 = "C".repeat(500);
      const longThinking = "D".repeat(5000);
      const event: DashboardEvent = {
        eventType: "message_start",
        timestamp: Date.now(),
        data: {
          message: {
            role: "user",
            content: [
              { type: "image", data: longBase64, mimeType: "image/png" },
            ],
          },
          thinking: longThinking,
        },
      };
      store.insertEvent("s1", event);
      const stored = store.getEvent("s1", 1);
      const content = (stored as any).data.message.content[0];
      expect(content.data).toBe(longBase64); // preserved
      const thinking = (stored as any).data.thinking as string;
      expect(thinking).toContain("truncated"); // truncated
      expect(thinking.length).toBeLessThan(longThinking.length); // shorter than original
    });
  });

  describe("getMaxSeq", () => {
    it("returns 0 for unknown session", () => {
      const store = createMemoryEventStore(neverPinned);
      expect(store.getMaxSeq("unknown")).toBe(0);
    });

    it("returns highest seq for session with events", () => {
      const store = createMemoryEventStore(neverPinned);
      store.insertEvent("s1", makeEvent());
      store.insertEvent("s1", makeEvent());
      store.insertEvent("s1", makeEvent());
      expect(store.getMaxSeq("s1")).toBe(3);
    });

    it("returns 0 after deleteEventsForSession", () => {
      const store = createMemoryEventStore(neverPinned);
      store.insertEvent("s1", makeEvent());
      store.insertEvent("s1", makeEvent());
      store.deleteEventsForSession("s1");
      expect(store.getMaxSeq("s1")).toBe(0);
    });

    it("returns correct seq after oldest events trimmed", () => {
      const store = createMemoryEventStore(neverPinned, 100, 3);
      store.insertEvent("s1", makeEvent());
      store.insertEvent("s1", makeEvent());
      store.insertEvent("s1", makeEvent());
      store.insertEvent("s1", makeEvent()); // seq 4, oldest (seq 1) trimmed
      expect(store.getMaxSeq("s1")).toBe(4);
    });
  });

  it("trims oldest events when per-session limit exceeded", () => {
    const store = createMemoryEventStore(neverPinned, 100, 3);
    store.insertEvent("s1", makeEvent("a"));
    store.insertEvent("s1", makeEvent("b"));
    store.insertEvent("s1", makeEvent("c"));
    store.insertEvent("s1", makeEvent("d"));

    const events = store.getEvents("s1", 1);
    expect(events).toHaveLength(3);
    // Oldest event (seq 1) should be trimmed
    expect(events[0].seq).toBe(2);
    expect(events[2].seq).toBe(4);
  });

  describe("raw_content deep-strip", () => {
    // Build an event whose raw_content sits at a controllable nesting depth.
    function eventWithRawContentAtDepth(depth: number, payload: string): DashboardEvent {
      let node: Record<string, unknown> = { raw_content: payload };
      for (let i = 0; i < depth; i++) node = { nested: node };
      return { eventType: "tool_execution_end", timestamp: Date.now(), data: node };
    }
    function findRawContent(obj: unknown): unknown {
      if (!obj || typeof obj !== "object") return undefined;
      if ("raw_content" in (obj as Record<string, unknown>)) return (obj as Record<string, unknown>).raw_content;
      for (const v of Object.values(obj as Record<string, unknown>)) {
        const hit = findRawContent(v);
        if (hit !== undefined) return hit;
      }
      return undefined;
    }

    for (const depth of [1, 2, 3, 4, 5, 6]) {
      it(`strips raw_content nested at depth ${depth}`, () => {
        const store = createMemoryEventStore(neverPinned);
        const big = "Z".repeat(200_000); // 200 KB of webpage text
        store.insertEvent("s1", eventWithRawContentAtDepth(depth, big));
        const stored = store.getEvent("s1", 1);
        const rc = findRawContent((stored as any).data) as string;
        expect(rc).toMatch(/^\[stripped \d+kb raw_content\]$/);
        expect(rc.length).toBeLessThan(200);
      });
    }

    it("strips camelCase rawContent too", () => {
      const store = createMemoryEventStore(neverPinned);
      const event: DashboardEvent = {
        eventType: "test",
        timestamp: Date.now(),
        data: { results: [{ rawContent: "Y".repeat(120_000) }] },
      };
      store.insertEvent("s1", event);
      const stored = store.getEvent("s1", 1);
      const rc = (stored as any).data.results[0].rawContent as string;
      expect(rc).toMatch(/^\[stripped \d+kb raw_content\]$/);
    });

    it("DEFENSE-IN-DEPTH: strips raw_content even when truncation is disabled (maxStringFieldSize=0)", () => {
      // This is the exact prod-regression shape: config flipped truncator OFF.
      // raw_content must STILL be stripped — it is unconditional, not gated on maxSize.
      const store = createMemoryEventStore(neverPinned, 100, 5000, 0);
      const event: DashboardEvent = {
        eventType: "tool_execution_end",
        timestamp: Date.now(),
        data: { mcpResult: { structuredContent: { results: [{ raw_content: "W".repeat(500_000) }] } } },
      };
      store.insertEvent("s1", event);
      const stored = store.getEvent("s1", 1);
      const rc = (stored as any).data.mcpResult.structuredContent.results[0].raw_content as string;
      expect(rc).toMatch(/^\[stripped \d+kb raw_content\]$/);
      // And the whole event is now tiny, not 500 KB.
      expect(store.sessionBytes("s1")).toBeLessThan(1000);
    });
  });

  describe("byte-cap enforcement (MAX_EVENT_DATA_SIZE)", () => {
    it("retains a multi-MB raw_content event as a tiny stored event", () => {
      const store = createMemoryEventStore(neverPinned);
      const event: DashboardEvent = {
        eventType: "tool_execution_end",
        timestamp: Date.now(),
        data: {
          toolName: "tavily_search",
          toolCallId: "call_123",
          message: { role: "tool", content: "search results summary" },
          mcpResult: { structuredContent: { results: [{ raw_content: "M".repeat(5_000_000) }] } },
        },
      };
      store.insertEvent("s1", event);
      // 5 MB in → well under 64 KB retained.
      expect(store.sessionBytes("s1")).toBeLessThan(64_000);
    });

    it("summarizes an over-cap event while preserving UI-render fields", () => {
      const store = createMemoryEventStore(neverPinned);
      // Many medium strings under the per-field cap but huge in aggregate,
      // none of which is raw_content — forces the total-byte backstop.
      const data: Record<string, unknown> = {
        toolName: "big_tool",
        toolCallId: "abc",
        isError: false,
        message: { role: "assistant", content: "hello world preview text" },
      };
      for (let i = 0; i < 100; i++) data[`field_${i}`] = "q".repeat(3_900);
      store.insertEvent("s1", { eventType: "tool_execution_end", timestamp: Date.now(), data });
      const stored = store.getEvent("s1", 1) as any;
      expect(stored.data.__truncated).toBe(true);
      expect(stored.data.toolName).toBe("big_tool");
      expect(stored.data.toolCallId).toBe("abc");
      expect(stored.data.message.role).toBe("assistant");
      expect(stored.data.message.content).toContain("hello world");
      expect(store.sessionBytes("s1")).toBeLessThan(64_000);
    });

    it("leaves a normal small event unsummarized", () => {
      const store = createMemoryEventStore(neverPinned);
      store.insertEvent("s1", {
        eventType: "message_end",
        timestamp: Date.now(),
        data: { message: { role: "assistant", content: "short reply" } },
      });
      const stored = store.getEvent("s1", 1) as any;
      expect(stored.data.__truncated).toBeUndefined();
      expect(stored.data.message.content).toBe("short reply");
    });
  });

  describe("byte accounting", () => {
    it("tracks total + per-session bytes and releases on trim", () => {
      const store = createMemoryEventStore(neverPinned, 100, 2);
      expect(store.bytesRetained()).toBe(0);
      store.insertEvent("s1", { eventType: "a", timestamp: 1, data: { x: "hello" } });
      const afterOne = store.bytesRetained();
      expect(afterOne).toBeGreaterThan(0);
      expect(store.sessionBytes("s1")).toBe(afterOne);
      store.insertEvent("s1", { eventType: "b", timestamp: 2, data: { x: "world" } });
      store.insertEvent("s1", { eventType: "c", timestamp: 3, data: { x: "third" } });
      // per-session cap=2 → oldest trimmed; total stays consistent with 2 events.
      expect(store.getEvents("s1", 1)).toHaveLength(2);
      expect(store.sessionBytes("s1")).toBe(store.bytesRetained());
      expect(store.bytesRetained()).toBeGreaterThan(0);
    });

    it("releases bytes when a session is deleted", () => {
      const store = createMemoryEventStore(neverPinned);
      store.insertEvent("s1", { eventType: "a", timestamp: 1, data: { x: "hello" } });
      store.insertEvent("s2", { eventType: "a", timestamp: 1, data: { x: "world" } });
      expect(store.bytesRetained()).toBeGreaterThan(0);
      const s1Bytes = store.sessionBytes("s1");
      const totalBefore = store.bytesRetained();
      store.deleteEventsForSession("s1");
      expect(store.sessionBytes("s1")).toBe(0);
      expect(store.bytesRetained()).toBe(totalBefore - s1Bytes);
    });

    it("releases bytes when a session is LRU-evicted", () => {
      const store = createMemoryEventStore(neverPinned, 2);
      store.insertEvent("s1", { eventType: "a", timestamp: 1, data: { x: "aaaa" } });
      store.insertEvent("s2", { eventType: "a", timestamp: 1, data: { x: "bbbb" } });
      store.insertEvent("s3", { eventType: "a", timestamp: 1, data: { x: "cccc" } }); // evicts s1
      expect(store.sessionCount()).toBe(2);
      // Total equals the sum of the two surviving sessions — no leaked accounting.
      expect(store.bytesRetained()).toBe(store.sessionBytes("s2") + store.sessionBytes("s3"));
    });
  });
});
