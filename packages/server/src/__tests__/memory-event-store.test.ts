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

  describe("operator/agent message-content preservation (bidirectional truncation fix)", () => {
    // Use a tiny per-string cap so a modest test string exceeds it; the real
    // default is 4000 — the cap the operator's long messages were hitting. The
    // exemption must hold at ANY cap, in BOTH directions (user + assistant).
    const SMALL_CAP = 100;
    const longText = "P".repeat(500); // > SMALL_CAP
    const small = () => createMemoryEventStore(neverPinned, 100, 5000, SMALL_CAP);

    it("preserves a long USER message (operator→agent) whole — no …[truncated]", () => {
      const store = small();
      store.insertEvent("s1", {
        eventType: "message_start",
        timestamp: Date.now(),
        data: { message: { role: "user", content: longText } },
      });
      const stored = store.getEvent("s1", 1) as any;
      expect(stored.data.message.content).toBe(longText);
      expect(stored.data.message.content).not.toContain("truncated");
    });

    it("preserves a long ASSISTANT message (agent→operator) whole — no …[truncated]", () => {
      const store = small();
      store.insertEvent("s1", {
        eventType: "message_end",
        timestamp: Date.now(),
        data: { message: { role: "assistant", content: longText } },
      });
      const stored = store.getEvent("s1", 1) as any;
      expect(stored.data.message.content).toBe(longText);
      expect(stored.data.message.content).not.toContain("truncated");
    });

    it("preserves a long TEXT BLOCK inside a user message content array", () => {
      const store = small();
      store.insertEvent("s1", {
        eventType: "message_start",
        timestamp: Date.now(),
        data: { message: { role: "user", content: [{ type: "text", text: longText }] } },
      });
      const stored = store.getEvent("s1", 1) as any;
      expect(stored.data.message.content[0].text).toBe(longText);
    });

    it("STILL truncates tool-result content (role:toolResult) — bloat defense preserved", () => {
      const store = small();
      store.insertEvent("s1", {
        eventType: "tool_execution_end",
        timestamp: Date.now(),
        data: { message: { role: "toolResult", toolName: "t", content: longText } },
      });
      const stored = store.getEvent("s1", 1) as any;
      expect(stored.data.message.content.length).toBeLessThan(longText.length);
      expect(stored.data.message.content).toContain("truncated");
    });

    it("STILL truncates a non-message string field — cap preserved", () => {
      const store = small();
      store.insertEvent("s1", {
        eventType: "test",
        timestamp: Date.now(),
        data: { meta: { note: longText } },
      });
      const stored = store.getEvent("s1", 1) as any;
      expect(stored.data.meta.note.length).toBeLessThan(longText.length);
      expect(stored.data.meta.note).toContain("truncated");
    });

    it("STILL caps a thinking block on an assistant message (legit cap preserved)", () => {
      const store = small();
      const longThinking = "T".repeat(2000);
      store.insertEvent("s1", {
        eventType: "message_end",
        timestamp: Date.now(),
        data: { message: { role: "assistant", content: longText, thinking: longThinking } },
      });
      const stored = store.getEvent("s1", 1) as any;
      expect(stored.data.message.content).toBe(longText); // message preserved
      expect(stored.data.message.thinking).toContain("truncated"); // thinking still capped
      expect(stored.data.message.thinking.length).toBeLessThan(longThinking.length);
    });

    it("STILL strips raw_content even inside a user message (defense-in-depth)", () => {
      const store = small();
      store.insertEvent("s1", {
        eventType: "message_start",
        timestamp: Date.now(),
        data: { message: { role: "user", content: [{ type: "text", text: longText, raw_content: "R".repeat(50_000) }] } },
      });
      const stored = store.getEvent("s1", 1) as any;
      const block = stored.data.message.content[0];
      expect(block.text).toBe(longText); // message text preserved
      expect(block.raw_content).toMatch(/^\[stripped \d+kb raw_content\]$/); // raw_content still stripped
    });
  });

  describe("chat-message preservation under the TOTAL-BYTE cap (over-cap summary)", () => {
    // Regression: a long orchestrator message rendered as ~4 lines ending mid
    // `**bold**` (literal `**`). Root cause: the total-event-byte cap
    // (MAX_EVENT_DATA_SIZE = 64_000) routed the WHOLE event through
    // summarizeOverCap, which clipped the assistant message content to a
    // 200-char preview. The per-string-cap exemption (preserveStrings) and the
    // image-byte exemption did not cover the byte-cap summary for chat TEXT.
    // These tests pin the fix: chat text survives the byte-cap summary WHOLE,
    // while non-chat (tool) bloat is still shed. Default store (4000 per-string
    // cap, real config); the bloat that trips the byte cap is a large
    // non-text block that survives field-level sanitization.

    // Mirrors the real failing message (Joan, 2026-06-28T13:08:38Z): the `**`
    // bold opener sits at ~offset 151, so a 200-char clip lands INSIDE the bold
    // span and drops the closing `**` → unclosed marker → renders literally.
    const prefix =
      "This is the most important thing you've said tonight — and you're right. " +
      "Let me reflect it back sharp, because getting the framing right IS the work:\n\n";
    const bold = "**We've been building fragile, then patching the fragility instead of curing it**";
    const tail = "\n\nYour two steps are exactly right. Let me lock them in and dispatch Step 1 now.";
    const prose = prefix + bold + tail;

    it("preserves a long ASSISTANT message WHOLE when a big non-text block trips the byte cap (the bug)", () => {
      const store = createMemoryEventStore(neverPinned); // real defaults (4000 per-string cap, 64k byte cap)
      // A large `signature` on a thinking block survives field-level sanitize
      // (it is inside the preserved chat content, and is not a capped key), so
      // the serialized event exceeds MAX_EVENT_DATA_SIZE → summarizeOverCap.
      const fatSignature = "S".repeat(70_000);
      store.insertEvent("s1", {
        eventType: "message_update",
        timestamp: Date.now(),
        data: {
          message: {
            role: "assistant",
            content: [
              { type: "text", text: prose },
              { type: "thinking", thinking: "brief", signature: fatSignature },
            ],
          },
        },
      });
      const stored = store.getEvent("s1", 1) as any;

      // The over-cap summary DID fire (the event was genuinely > 64KB) …
      expect(stored.data.__truncated).toBe(true);
      // … and the 70KB non-text bloat was shed (memory bound preserved) …
      expect(JSON.stringify(stored).length).toBeLessThan(10_000);
      // … but the operator-visible chat text survived WHOLE — not clipped to 200.
      const content = stored.data.message.content;
      const text = typeof content === "string"
        ? content
        : content.find((b: any) => b.type === "text").text;
      expect(text).toBe(prose);
      expect(text.length).toBeGreaterThan(200);
      // The closing `**` is present → react-markdown renders <strong>, not a
      // literal `**`. The legacy 200-char clip dropped it (documented here).
      expect(text).toContain("curing it**");
      expect(prose.slice(0, 200)).not.toContain("curing it**");
    });

    it("preserves an ASSISTANT message whose chat TEXT itself exceeds the byte cap", () => {
      const store = createMemoryEventStore(neverPinned);
      const hugeProse = `${bold} `.repeat(1200); // ~100KB of genuine assistant prose, no bloat
      store.insertEvent("s1", {
        eventType: "message_end",
        timestamp: Date.now(),
        data: { message: { role: "assistant", content: hugeProse } },
      });
      const stored = store.getEvent("s1", 1) as any;
      // Chat text is operator-visible → preserved whole even though it alone
      // exceeds the byte cap (consistent with the per-string preserveStrings
      // exemption). It must NOT be reduced to a 200-char preview.
      expect(stored.data.message.content).toBe(hugeProse);
      expect(stored.data.message.content.length).toBe(hugeProse.length);
      expect(stored.data.message.content).toContain("curing it**");
    });

    it("STILL summarizes a NON-chat (toolResult) message to a short preview — byte-cap memory bound preserved", () => {
      const store = createMemoryEventStore(neverPinned);
      // 45 medium text blocks (~67KB total); each < 4000 so the per-string cap
      // leaves them intact, and 45 < MAX_ARRAY_LENGTH so the array survives —
      // the event clears 64KB and hits the byte cap as a non-chat message.
      const blocks = Array.from({ length: 45 }, () => ({ type: "text", text: "Z".repeat(1500) }));
      store.insertEvent("s1", {
        eventType: "tool_execution_end",
        timestamp: Date.now(),
        data: { message: { role: "toolResult", toolName: "t", content: blocks } },
      });
      const stored = store.getEvent("s1", 1) as any;
      expect(stored.data.__truncated).toBe(true);
      const content = stored.data.message.content;
      // Tool content is reduced to a short preview (NOT kept whole) — the
      // memory backstop still applies to non-operator-visible bloat.
      expect(typeof content).toBe("string");
      expect(content.length).toBeLessThanOrEqual(200);
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

    it("preserves the operator-voice audience stamp through an over-cap summary (Sol F2)", () => {
      // Sol fix-cycle-3 F2: summarizeOverCap rebuilt data.message and DROPPED
      // `audience`, so a stamped `agent` row on a large message fell through to the
      // retrospective and flipped category. The stamp must survive the summary.
      const store = createMemoryEventStore(neverPinned);
      const data: Record<string, unknown> = {
        message: { role: "assistant", content: "x".repeat(50), audience: "agent" },
      };
      for (let i = 0; i < 100; i++) data[`field_${i}`] = "q".repeat(3_900);
      store.insertEvent("s1", { eventType: "message_end", timestamp: Date.now(), data });
      const stored = store.getEvent("s1", 1) as any;
      expect(stored.data.__truncated).toBe(true); // the over-cap path DID fire
      expect(stored.data.message.audience).toBe("agent"); // stamp survived
    });

    it("preserves a corrupt-present (null) audience through an over-cap summary (Sol F2 fail-open)", () => {
      const store = createMemoryEventStore(neverPinned);
      const data: Record<string, unknown> = {
        message: { role: "assistant", content: "y".repeat(50), audience: null },
      };
      for (let i = 0; i < 100; i++) data[`field_${i}`] = "q".repeat(3_900);
      store.insertEvent("s1", { eventType: "message_end", timestamp: Date.now(), data });
      const stored = store.getEvent("s1", 1) as any;
      expect(stored.data.__truncated).toBe(true);
      // `null` is carried verbatim (present) so the client classifier fails it OPEN
      // (shown), rather than the summary dropping it → absent → hidden in a worker ctx.
      expect(stored.data.message.audience).toBe(null);
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

  describe("image preservation across the byte cap (regression)", () => {
    // A realistic screenshot: base64 well over the 64KB MAX_EVENT_DATA_SIZE.
    // Image bytes are exempt from the cap, so it must survive INTACT — not be
    // routed into the over-cap summary (which would destroy it).
    it("preserves a >64KB inline image in message.content (not summarized away)", () => {
      const store = createMemoryEventStore(neverPinned);
      const bigImage = "A".repeat(300_000); // ~300KB base64, > 64KB cap
      store.insertEvent("s1", {
        eventType: "message_start",
        timestamp: Date.now(),
        data: {
          message: {
            role: "user",
            content: [
              { type: "text", text: "look at this" },
              { type: "image", data: bigImage, mimeType: "image/png" },
            ],
          },
        },
      });
      const stored = store.getEvent("s1", 1) as any;
      // NOT summarized: original structure intact, image byte-identical.
      expect(stored.data.__truncated).toBeUndefined();
      expect(Array.isArray(stored.data.message.content)).toBe(true);
      const img = stored.data.message.content.find((b: any) => b.type === "image");
      expect(img.data).toBe(bigImage);
      expect(img.data).toHaveLength(300_000);
    });

    it("preserves a >64KB inline tool-result image (live result.content shape)", () => {
      const store = createMemoryEventStore(neverPinned);
      const bigImage = "B".repeat(250_000);
      store.insertEvent("s1", {
        eventType: "tool_execution_end",
        timestamp: Date.now(),
        data: {
          toolName: "screenshot",
          result: { content: [{ type: "image", data: bigImage, mimeType: "image/png" }] },
        },
      });
      const stored = store.getEvent("s1", 1) as any;
      expect(stored.data.__truncated).toBeUndefined();
      const img = stored.data.result.content.find((b: any) => b.type === "image");
      expect(img.data).toBe(bigImage);
    });

    it("carries images through the over-cap summary when paired with huge TEXT", () => {
      const store = createMemoryEventStore(neverPinned);
      const bigImage = "C".repeat(200_000);
      // Many medium strings, each UNDER the 4000 per-field cap (so field-level
      // truncation does not shrink them away), aggregating over 64KB of
      // non-image text → forces the total-byte summary WITH an image present.
      const extra: Record<string, unknown> = {};
      for (let i = 0; i < 40; i++) extra[`note_${i}`] = "n".repeat(3_500);
      store.insertEvent("s1", {
        eventType: "message_start",
        timestamp: Date.now(),
        data: {
          ...extra,
          message: {
            role: "user",
            content: [
              { type: "text", text: "see attached" },
              { type: "image", data: bigImage, mimeType: "image/png" },
            ],
          },
        },
      });
      const stored = store.getEvent("s1", 1) as any;
      // Summary fired (aggregate text was huge) BUT the image survived in the rebuilt content.
      expect(stored.data.__truncated).toBe(true);
      const img = stored.data.message.content.find((b: any) => b.type === "image");
      expect(img.data).toBe(bigImage);
    });

    it("carries replayed data.images[] through the over-cap summary", () => {
      const store = createMemoryEventStore(neverPinned);
      const bigImage = "D".repeat(150_000);
      const data: Record<string, unknown> = {
        toolName: "t",
        images: [{ data: bigImage, mimeType: "image/png" }],
      };
      // Pad with many sub-cap strings to force the total-byte summary.
      for (let i = 0; i < 40; i++) data[`f${i}`] = "z".repeat(3_500);
      store.insertEvent("s1", { eventType: "tool_execution_end", timestamp: Date.now(), data });
      const stored = store.getEvent("s1", 1) as any;
      expect(stored.data.__truncated).toBe(true);
      expect(stored.data.images[0].data).toBe(bigImage);
    });

    it("bounds a pathological >4MB image with a visible marker (not silent loss)", () => {
      const store = createMemoryEventStore(neverPinned);
      const huge = "E".repeat(5_000_000); // 5MB single image — over MAX_EVENT_IMAGE_BYTES
      store.insertEvent("s1", {
        eventType: "message_start",
        timestamp: Date.now(),
        data: { message: { role: "user", content: [{ type: "image", data: huge, mimeType: "image/png" }] } },
      });
      const stored = store.getEvent("s1", 1) as any;
      const img = stored.data.message.content[0];
      expect(img.data).toMatch(/^\[stripped \d+kb image\]$/); // marked, not vanished
      expect(store.sessionBytes("s1")).toBeLessThan(64_000);
    });

    it("caps a non-object oversized top-level data (backstop is total)", () => {
      const store = createMemoryEventStore(neverPinned);
      const event = { eventType: "weird", timestamp: Date.now(), data: "X".repeat(500_000) as any };
      store.insertEvent("s1", event);
      const stored = store.getEvent("s1", 1) as any;
      expect(stored.data.__truncated).toBe(true);
      expect(stored.data.__reason).toBe("non-object-data");
      expect(store.sessionBytes("s1")).toBeLessThan(64_000);
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
