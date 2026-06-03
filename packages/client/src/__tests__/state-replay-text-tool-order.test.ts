/**
 * Round-trip test for change: fix-text-tool-render-order.
 *
 * Asserts that an assistant entry with content `[text, toolCall]` replays
 * through `replayEntriesAsEvents` + the client reducer to produce a
 * `messages[]` whose suffix is `[..., assistant-text, toolResult]` \u2014
 * the same order as the model's content array. Without the reducer fix,
 * the order is reversed.
 */
import { describe, it, expect } from "vitest";
import { replayEntriesAsEvents } from "@blackbelt-technology/pi-dashboard-shared/state-replay.js";
import { createInitialState, reduceEvent } from "../lib/event-reducer.js";

function replayAndReduce(entries: any[]) {
  const events = replayEntriesAsEvents("sess-1", entries);
  let state = createInitialState();
  for (const env of events) {
    state = reduceEvent(state, env.event);
  }
  return state;
}

describe("state-replay text+toolCall order", () => {
  it("[text, toolCall] assistant message replays in content-array order", () => {
    // Real shape harvested from a pi 0.70 session JSONL (sanitised):
    // an assistant message that emits commentary and a tool call in the
    // same content array.
    const entries = [
      {
        type: "message",
        id: "u1",
        parentId: "root",
        timestamp: "2026-04-29T06:31:21.000Z",
        message: { role: "user", content: [{ type: "text", text: "go" }] },
      },
      {
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: "2026-04-29T06:31:21.500Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Now mark group 7 + 8:" },
            { type: "toolCall", id: "t1", name: "edit", arguments: { path: "x" } },
          ],
        },
      },
    ];

    const state = replayAndReduce(entries);
    const tail = state.messages.slice(-2);
    expect(tail.map((m) => m.role)).toEqual(["assistant", "toolResult"]);
    expect(tail[0].content).toBe("Now mark group 7 + 8:");
    expect(tail[1].toolCallId).toBe("t1");
  });

  it("two consecutive [text, toolCall] messages replay without cross-message bleed", () => {
    const entries = [
      {
        type: "message",
        id: "u1",
        parentId: "root",
        timestamp: "2026-04-29T06:31:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "go" }] },
      },
      {
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: "2026-04-29T06:31:21.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "First action:" },
            { type: "toolCall", id: "tA", name: "edit", arguments: {} },
          ],
        },
      },
      {
        type: "message",
        id: "a2",
        parentId: "a1",
        timestamp: "2026-04-29T06:31:25.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Second action:" },
            { type: "toolCall", id: "tB", name: "bash", arguments: {} },
          ],
        },
      },
    ];

    const state = replayAndReduce(entries);
    const idxAssistantA = state.messages.findIndex((m) => m.content === "First action:");
    const idxToolA = state.messages.findIndex((m) => m.toolCallId === "tA");
    const idxAssistantB = state.messages.findIndex((m) => m.content === "Second action:");
    const idxToolB = state.messages.findIndex((m) => m.toolCallId === "tB");

    expect(idxAssistantA).toBeGreaterThanOrEqual(0);
    expect(idxToolA).toBe(idxAssistantA + 1);
    expect(idxAssistantB).toBeGreaterThan(idxToolA);
    expect(idxToolB).toBe(idxAssistantB + 1);
  });

  it("[thinking, text, toolCall] assistant message replays as thinking → text → tool", () => {
    const entries = [
      {
        type: "message",
        id: "a1",
        parentId: "root",
        timestamp: "2026-04-29T06:31:21.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Let me think..." },
            { type: "text", text: "Going to call edit:" },
            { type: "toolCall", id: "t1", name: "edit", arguments: {} },
          ],
        },
      },
    ];

    const state = replayAndReduce(entries);
    const tail = state.messages.slice(-3);
    // After fix-thinking-block-streaming-state-loss-2026-05-25:
    // state-replay synthesizes thinking_* events for persisted
    // {type:"thinking"} content blocks, so the thinking row IS in the
    // suffix and precedes the assistant text + tool result.
    const thinkingIdx = tail.findIndex((m) => m.role === "thinking");
    const assistantIdx = tail.findIndex((m) => m.role === "assistant");
    const toolIdx = tail.findIndex((m) => m.role === "toolResult");
    expect(thinkingIdx).toBeGreaterThanOrEqual(0);
    expect(assistantIdx).toBeGreaterThanOrEqual(0);
    expect(toolIdx).toBeGreaterThanOrEqual(0);
    expect(thinkingIdx).toBeLessThan(assistantIdx);
    expect(assistantIdx).toBeLessThan(toolIdx);
  });

  // Regression suite for change: fix-thinking-block-streaming-state-
  // loss-2026-05-25. state-replay synthesizes message_update events
  // with assistantMessageEvent: { type: "thinking_start" | thinking_delta
  // | thinking_end } for every persisted {type:"thinking"} content
  // block so the reducer can rebuild role:"thinking" rows on cold-replay.

  it("[thinking] assistant message replays as a thinking row in messages[]", () => {
    const entries = [
      {
        type: "message",
        id: "a1",
        timestamp: "2026-04-29T06:31:21.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Reasoning content here.", thinkingSignature: "sig-1" },
          ],
        },
      },
    ];

    // Assert at synth-events level
    const events = replayEntriesAsEvents("sess-1", entries).map((m) => m.event);
    const startIdx = events.findIndex(
      (e) => e.eventType === "message_update"
        && (e.data as any).assistantMessageEvent?.type === "thinking_start",
    );
    const deltaIdx = events.findIndex(
      (e) => e.eventType === "message_update"
        && (e.data as any).assistantMessageEvent?.type === "thinking_delta",
    );
    const endIdx = events.findIndex(
      (e) => e.eventType === "message_update"
        && (e.data as any).assistantMessageEvent?.type === "thinking_end",
    );
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(deltaIdx).toBeGreaterThan(startIdx);
    expect(endIdx).toBeGreaterThan(deltaIdx);
    expect((events[deltaIdx].data as any).assistantMessageEvent.delta).toBe("Reasoning content here.");
    expect((events[endIdx].data as any).assistantMessageEvent.signature).toBe("sig-1");

    // Assert at reduced-state level: the thinking row is in messages[].
    const state = replayAndReduce(entries);
    const thinkingRows = state.messages.filter((m) => m.role === "thinking");
    expect(thinkingRows).toHaveLength(1);
    expect(thinkingRows[0].content).toBe("Reasoning content here.");
  });

  it("empty thinking content does NOT synthesize events", () => {
    const entries = [
      {
        type: "message",
        id: "a1",
        timestamp: "2026-04-29T06:31:21.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "" },
            { type: "text", text: "hello" },
          ],
        },
      },
    ];

    const events = replayEntriesAsEvents("sess-1", entries).map((m) => m.event);
    const hasThinkingStart = events.some(
      (e) => e.eventType === "message_update"
        && (e.data as any).assistantMessageEvent?.type === "thinking_start",
    );
    expect(hasThinkingStart).toBe(false);

    // And no thinking row in messages[]
    const state = replayAndReduce(entries);
    expect(state.messages.some((m) => m.role === "thinking")).toBe(false);
  });

  it("multiple thinking blocks in one assistant message both produce synthesized events", () => {
    // Empirical note: this scenario has not been observed in 2636 real
    // assistant messages sampled across 30 recent sessions (all have
    // n=0 or n=1 thinking blocks per message). Test is defensive only.
    //
    // The reorder pass at message_end pairs thinking rows by walking
    // suffix backwards (findLastUnclaimed), which preserves correct
    // pairing for the dominant n=1 case but reverses the pairing when
    // n>=2 within a single message. We assert at the synth-events
    // level (always correct) rather than the reduced-state level
    // (subject to the reorder-helper limitation). The multi-thinking-
    // reorder N-to-N pairing limitation is a v0.5+ candidate sister-
    // cluster signal for the reorder helper at event-reducer.ts:~388
    // findLastUnclaimed.
    const entries = [
      {
        type: "message",
        id: "a1",
        timestamp: "2026-04-29T06:31:21.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "first thought" },
            { type: "toolCall", id: "t1", name: "edit", arguments: {} },
            { type: "thinking", thinking: "second thought after tool" },
            { type: "text", text: "final answer" },
          ],
        },
      },
    ];

    const events = replayEntriesAsEvents("sess-1", entries).map((m) => m.event);
    const thinkingEndDeltas = events
      .filter((e) =>
        e.eventType === "message_update"
        && (e.data as any).assistantMessageEvent?.type === "thinking_delta",
      )
      .map((e) => (e.data as any).assistantMessageEvent.delta as string);
    expect(thinkingEndDeltas).toEqual(["first thought", "second thought after tool"]);

    // At reduced-state level, the reorder pass produces two thinking
    // rows (count is correct); pairing-order is a known pre-existing
    // limitation banked as v0.5+ candidate.
    const state = replayAndReduce(entries);
    const thinkingRows = state.messages.filter((m) => m.role === "thinking");
    expect(thinkingRows).toHaveLength(2);
  });
});
