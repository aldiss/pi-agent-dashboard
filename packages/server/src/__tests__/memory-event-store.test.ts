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

  describe("MAX_EVENT_DATA_SIZE cap-enforcement (invariant I4) [W5]", () => {
    // Cell dashboard-memory-pressure-fix/v1 W5 test authoring per W2 design-pass
    // doc § Axis 3 invariant I4. Asserts the post-walk total-serialized-cap gate
    // at createTruncator() (memory-event-store.ts) replaces oversized events with
    // summarizeOversizedEvent() shape preserving UI-required fields.

    // The MAX_EVENT_DATA_SIZE module-level constant (30_000). Mirror here for
    // assertion clarity; if memory-event-store.ts changes the cap, this
    // mirror MUST be updated SAME-COMMIT per Schema 5 § 3.9.
    const CAP = 30_000;

    it("T1 (AFR-shape): nested MCP payload (multi-MB raw_content + deep content[0].text) → stored event ≤ cap", () => {
      // Default ctor (maxStringFieldSize=4000); empirically reproduces the AFR
      // JSONL line 130 shape per Pete-evidence-bundle § Concrete evidence.
      const store = createMemoryEventStore(neverPinned);
      const bigRaw = "R".repeat(108_208); // matches AFR raw_content[*] empirical shape
      const bigText = "T".repeat(1_340_556); // matches AFR mcpResult.content[0].text empirical shape
      const event: DashboardEvent = {
        eventType: "tool_execution_end",
        timestamp: Date.now(),
        data: {
          toolCallId: "t1",
          toolName: "mcp_search",
          isError: false,
          message: {
            role: "toolResult",
            content: [{ type: "text", text: bigText }],
            details: {
              mcpResult: {
                content: [{ type: "text", text: bigText }],
                structuredContent: {
                  results: [
                    { url: "https://example.com/1", raw_content: bigRaw },
                    { url: "https://example.com/2", raw_content: bigRaw },
                    { url: "https://example.com/3", raw_content: bigRaw },
                  ],
                },
              },
            },
          },
        },
      };
      store.insertEvent("s1", event);
      const stored = store.getEvent("s1", 1);
      const serialized = JSON.stringify((stored as any).data).length;
      expect(serialized).toBeLessThanOrEqual(CAP);
      // raw_content carve-out 3 fired — strip-by-name annotation present.
      const flat = JSON.stringify(stored);
      expect(flat).toContain("raw_content stripped: 108208 bytes");
      // content[0].text was truncated (string-cap fired at depth ≥ 4 since the
      // depth>4 short-circuit was removed in W3).
      expect(flat).toContain("[truncated]");
    });

    it("T2 (cap-gate via summarize): oversized event triggers __summary fallback preserving toolCallId/toolName/isError", () => {
      // Use large maxStringFieldSize (100_000) so per-string truncation does
      // NOT fire; this isolates the post-walk total-cap gate behavior.
      const store = createMemoryEventStore(neverPinned, 100, 5000, 100_000);
      const big = "X".repeat(60_000);
      const event: DashboardEvent = {
        eventType: "tool_execution_end",
        timestamp: Date.now(),
        data: {
          toolCallId: "tool-call-42",
          toolName: "bash",
          isError: true,
          result: big,
          message: {
            role: "toolResult",
            content: [{ type: "text", text: big }],
          },
          type: "tool_execution_end",
        },
      };
      store.insertEvent("s1", event);
      const stored = store.getEvent("s1", 1);
      const d = (stored as any).data;
      // __summary marker present with originalSize > cap.
      expect(d.__summary).toBeDefined();
      expect(d.__summary.cap).toBe(CAP);
      expect(d.__summary.originalSize).toBeGreaterThan(CAP);
      // UI-required fields preserved verbatim.
      expect(d.toolCallId).toBe("tool-call-42");
      expect(d.toolName).toBe("bash");
      expect(d.isError).toBe(true);
      // result truncated to ≤ 1_500 + suffix; not full 60_000.
      expect(typeof d.result).toBe("string");
      expect(d.result.length).toBeLessThan(2_000);
      expect(d.result).toContain("truncated");
      // Total serialized ≤ cap (the WHOLE point).
      expect(JSON.stringify(d).length).toBeLessThanOrEqual(CAP);
    });

    it("T3 (under-cap negative): small event has NO __summary marker", () => {
      const store = createMemoryEventStore(neverPinned);
      const event: DashboardEvent = {
        eventType: "tool_execution_end",
        timestamp: Date.now(),
        data: {
          toolCallId: "t1",
          toolName: "bash",
          isError: false,
          result: "hello world",
        },
      };
      store.insertEvent("s1", event);
      const stored = store.getEvent("s1", 1);
      const d = (stored as any).data;
      expect(d.__summary).toBeUndefined();
      expect(d.result).toBe("hello world"); // verbatim — no truncation
      expect(d.toolCallId).toBe("t1");
    });

    it("T4 (I1×I4 composition): oversized event with images preserves images verbatim through summary fallback", () => {
      // Image-preservation invariant (I1) MUST compose with cap-fallback (I4):
      // when summary fires, summary.images = d.images (verbatim copy).
      const store = createMemoryEventStore(neverPinned, 100, 5000, 100_000);
      const big = "X".repeat(60_000);
      const imageData = "BASE64IMAGE".repeat(50); // small image, NOT truncated
      const event: DashboardEvent = {
        eventType: "tool_execution_end",
        timestamp: Date.now(),
        data: {
          toolCallId: "t1",
          toolName: "screenshot",
          isError: false,
          result: big, // pushes total over cap
          images: [{ data: imageData, mimeType: "image/png" }],
        },
      };
      store.insertEvent("s1", event);
      const stored = store.getEvent("s1", 1);
      const d = (stored as any).data;
      expect(d.__summary).toBeDefined();
      // I1 composition: images preserved verbatim through summary path.
      expect(d.images).toEqual([{ data: imageData, mimeType: "image/png" }]);
      expect(d.images[0].data).toBe(imageData); // identity verbatim
    });

    it("T5 (I2×I4 composition): oversized event with entryId preserves entryId through summary fallback", () => {
      // EntryId-fidelity invariant (I2) MUST compose with cap-fallback (I4):
      // assistant message_end carrying multi-MB content survives cap-gate
      // WITH entryId intact for client reducer reconstruction (W4 path).
      const store = createMemoryEventStore(neverPinned, 100, 5000, 100_000);
      const big = "Y".repeat(60_000);
      const event: DashboardEvent = {
        eventType: "message_end",
        timestamp: Date.now(),
        data: {
          entryId: "entry-canonical-abc-123",
          message: {
            role: "assistant",
            content: [{ type: "text", text: big }],
          },
        },
      };
      store.insertEvent("s1", event);
      const stored = store.getEvent("s1", 1);
      const d = (stored as any).data;
      expect(d.__summary).toBeDefined();
      expect(d.entryId).toBe("entry-canonical-abc-123"); // I2 preserved
      expect(d.message.role).toBe("assistant");
      // message.content text-summary slice — bounded by 2_000 + suffix.
      expect(typeof d.message.content).toBe("string");
      expect(d.message.content.length).toBeLessThan(2_100);
      expect(d.message.content).toContain("truncated");
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
});
