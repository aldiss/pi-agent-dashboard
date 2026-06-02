/**
 * Round-trip test for state-replay (per change: fix-per-message-fork):
 * for every persisted entry, the reducer-equivalent message_start /
 * message_end carries entryId === entry.id. Replay does NOT need
 * entry_persisted back-fill because it reads from the persisted JSONL.
 */
import { describe, it, expect } from "vitest";
import { replayEntriesAsEvents } from "../state-replay.js";

describe("replayEntriesAsEvents — entryId fidelity", () => {
  it("stamps entryId on user message_start matching the source entry id", () => {
    const sessionId = "sess-1";
    const entries = [
      {
        type: "message",
        id: "u1",
        parentId: "root",
        timestamp: "2026-04-27T07:26:25.000Z",
        message: { role: "user", content: [{ type: "text", text: "Hello" }] },
      },
    ];

    const events = replayEntriesAsEvents(sessionId, entries);
    const start = events.find((e) => e.event.eventType === "message_start");
    expect(start).toBeDefined();
    expect((start!.event.data as any).entryId).toBe("u1");
  });

  it("stamps entryId on assistant message_end matching the source entry id", () => {
    const sessionId = "sess-1";
    const entries = [
      {
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: "2026-04-27T07:26:30.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "Hi!" }] },
      },
    ];

    const events = replayEntriesAsEvents(sessionId, entries);
    const end = events.find((e) => e.event.eventType === "message_end");
    expect(end).toBeDefined();
    expect((end!.event.data as any).entryId).toBe("a1");
  });

  it("emits no entry_persisted events during replay", () => {
    const sessionId = "sess-1";
    const entries = [
      {
        type: "message",
        id: "u1",
        timestamp: "2026-04-27T07:26:25.000Z",
        message: { role: "user", content: [{ type: "text", text: "Hi" }] },
      },
      {
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: "2026-04-27T07:26:30.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "Hello!" }] },
      },
    ];

    const events = replayEntriesAsEvents(sessionId, entries);
    const persisted = events.filter((e) => e.event.eventType === "entry_persisted");
    expect(persisted).toHaveLength(0);
  });

  // Cell dashboard-memory-pressure-fix/v1 W5 test authoring per W2 design-pass
  // Axis 2 (replay-duplication reduction). Asserts no full-message
  // `message_update` is emitted during assistant-entry replay; only
  // `message_end` carries the full `msg` payload + `entryId`.
  it("T6a [W5]: assistant replay emits NO full-message message_update (only message_end carries full msg)", () => {
    const sessionId = "sess-1";
    const entries = [
      {
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: "2026-04-27T07:26:30.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Body of assistant reply" },
          ],
        },
      },
    ];

    const events = replayEntriesAsEvents(sessionId, entries);
    // Any message_update events emitted during assistant replay must be
    // synthetic block-events (thinking_start/_delta/_end) carrying an
    // `assistantMessageEvent` discriminator — NOT a full `message: msg`
    // payload that would double the in-memory event-store footprint.
    const updates = events.filter((e) => e.event.eventType === "message_update");
    for (const u of updates) {
      const data = u.event.data as any;
      expect(data.message).toBeUndefined(); // no full-message duplication
      expect(data.assistantMessageEvent).toBeDefined(); // synthetic block-event only
    }
    // The message_end event carries the full msg + entryId canonical.
    const end = events.find((e) => e.event.eventType === "message_end");
    expect(end).toBeDefined();
    expect((end!.event.data as any).message).toBeDefined();
    expect((end!.event.data as any).entryId).toBe("a1");
  });

  it("T6b [W5]: assistant replay with text content emits zero message_update events (W4 deletion proof)", () => {
    // Pre-W4 shape emitted message_update with full msg + message_end with full msg
    // — doubling the multi-MB payload. Post-W4: only message_end. For text-only
    // assistant entries (no thinking blocks, no toolCall blocks), zero
    // message_update events should be emitted at all.
    const sessionId = "sess-1";
    const entries = [
      {
        type: "message",
        id: "a1",
        timestamp: "2026-04-27T07:26:30.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "plain reply" }],
        },
      },
    ];
    const events = replayEntriesAsEvents(sessionId, entries);
    const updates = events.filter((e) => e.event.eventType === "message_update");
    expect(updates).toHaveLength(0);
    // entryId-fidelity preserved (I2).
    const end = events.find((e) => e.event.eventType === "message_end")!;
    expect((end.event.data as any).entryId).toBe("a1");
  });
});
