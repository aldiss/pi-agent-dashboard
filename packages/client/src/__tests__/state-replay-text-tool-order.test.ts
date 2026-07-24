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
import { extractFinalizedAssistantProse, sha256Hex } from "@blackbelt-technology/pi-dashboard-shared/operator-delivery.js";
import { createInitialState, reduceEvent } from "../lib/event-reducer.js";

function stampAgentMessage(message: Record<string, unknown>): Record<string, unknown> {
  const source = extractFinalizedAssistantProse(message.content);
  return {
    ...message,
    audience: "agent",
    operatorDelivery: { version: 1, sourceSha256: sha256Hex(source), status: "agent" },
  };
}

function replayAndReduce(entries: any[]) {
  const stamped = entries.map((entry) => entry?.message?.role === "assistant"
    ? { ...entry, message: stampAgentMessage(entry.message) }
    : entry);
  const events = replayEntriesAsEvents("sess-1", stamped);
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

  it("[thinking, text, toolCall] delays thinking until final agent proof, then preserves order", () => {
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

  it("[thinking] synthesis stays hidden pre-final and becomes one finalized agent row", () => {
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

    // The authoritative agent-stamped message_end reconstructs the row.
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
    // Defensive multi-block fixture: finalized content indexes make the
    // N-to-N thinking order deterministic even around a tool call.
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

    const state = replayAndReduce(entries);
    const thinkingRows = state.messages.filter((m) => m.role === "thinking");
    expect(thinkingRows.map((row) => row.content)).toEqual([
      "first thought",
      "second thought after tool",
    ]);
    expect(state.messages.slice(-4).map((row) => [row.role, row.content])).toEqual([
      ["thinking", "first thought"],
      ["toolResult", "edit"],
      ["thinking", "second thought after tool"],
      ["assistant", "final answer"],
    ]);
  });

  it("replaying the same finalized entry twice is idempotent for text, thinking, and tools", () => {
    const entries = [{
      type: "message",
      id: "a-idempotent",
      timestamp: "2026-04-29T06:31:21.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private agent detail" },
          { type: "text", text: "Final agent text" },
          { type: "toolCall", id: "t-idempotent", name: "read", arguments: { path: "x" } },
        ],
      },
    }];
    const stampedEntries = entries.map((entry) => ({
      ...entry,
      message: stampAgentMessage(entry.message),
    }));
    const events = replayEntriesAsEvents("sess-1", stampedEntries);
    let state = createInitialState();
    for (const pass of [events, events]) {
      for (const envelope of pass) {
        state = reduceEvent(state, envelope.event);
      }
    }
    expect(state.messages.filter((row) => row.role === "thinking")).toHaveLength(1);
    expect(state.messages.filter((row) => row.role === "assistant")).toHaveLength(1);
    expect(state.messages.filter((row) => row.toolCallId === "t-idempotent")).toHaveLength(1);
  });
});
