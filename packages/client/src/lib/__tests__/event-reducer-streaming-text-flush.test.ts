import { describe, expect, it } from "vitest";
import type { DashboardEvent } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import { createInitialState, reduceEvent, type SessionState } from "../event-reducer.js";
import { sha256Hex } from "../operator-delivery.js";

function reduce(events: DashboardEvent[]): SessionState {
  return events.reduce(reduceEvent, createInitialState());
}

const SOURCE = "Per dl-11743 §2A, CODENAME-47 failed. Decision: do not deploy.";
const PLAIN = "The final review failed. Do not deploy.";

function start(timestamp = 1): DashboardEvent {
  return { eventType: "message_start", timestamp, data: { message: { role: "assistant", content: [] } } } as DashboardEvent;
}

function update(timestamp = 2): DashboardEvent {
  return {
    eventType: "message_update",
    timestamp,
    data: {
      message: { role: "assistant", audience: "agent", content: [{ type: "text", text: SOURCE }] },
      assistantMessageEvent: { type: "text_delta", delta: SOURCE },
    },
  } as DashboardEvent;
}

function toolStart(timestamp = 3): DashboardEvent {
  return {
    eventType: "tool_execution_start",
    timestamp,
    data: { toolCallId: "tool-1", toolName: "bash", args: { command: "npm test" } },
  } as DashboardEvent;
}

function end(
  content: unknown[],
  options: {
    audience?: "operator" | "agent" | "unknown";
    entryId?: string;
    nonce?: string;
    timestamp?: number;
    plain?: string;
  } = {},
): DashboardEvent {
  const source = content
    .filter((part: any) => part?.type === "text")
    .map((part: any) => part.text)
    .join("");
  const audience = options.audience ?? "agent";
  return {
    eventType: "message_end",
    timestamp: options.timestamp ?? 4,
    data: {
      message: {
        role: "assistant",
        audience,
        content,
        ...(audience === "agent" ? {
          operatorDelivery: {
            version: 1,
            sourceSha256: sha256Hex(source),
            status: "agent",
          },
        } : {
          operatorDelivery: {
            version: 1,
            sourceSha256: sha256Hex(source),
            status: "ready",
            text: options.plain ?? PLAIN,
            checks: { plain: true, anchorsPreserved: true },
          },
        }),
      },
      entryId: options.entryId,
      nonce: options.nonce,
    },
  } as DashboardEvent;
}

describe("assistant hold across tool ordering", () => {
  it("does not flush untrusted partial prose when a tool starts", () => {
    const state = reduce([start(), update(), toolStart()]);
    expect(state.messages.map((message) => message.role)).toEqual(["toolResult"]);
    expect(state.messages.some((message) => message.content.includes("dl-11743"))).toBe(false);
    expect(state.streamingText).toBe("");
    expect(state.streamingTextFlushed).toBe(false);
  });

  it("places finalized agent prose before its tool card only at message_end", () => {
    const state = reduce([
      start(),
      update(),
      toolStart(),
      {
        eventType: "message_end",
        timestamp: 4,
        data: {
          message: {
            role: "assistant",
            audience: "agent",
            content: [
              { type: "text", text: SOURCE },
              { type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "npm test" } },
            ],
            operatorDelivery: {
              version: 1,
              sourceSha256: sha256Hex(SOURCE),
              status: "agent",
            },
          },
        },
      } as DashboardEvent,
    ]);
    expect(state.messages.map((message) => message.role)).toEqual(["assistant", "toolResult"]);
    expect(state.messages[0].content).toBe(SOURCE);
  });

  it("places verified plain prose before tool and interactive rows", () => {
    const state = reduce([
      start(),
      update(),
      toolStart(),
      {
        eventType: "message_end",
        timestamp: 4,
        data: {
          message: {
            role: "assistant",
            audience: "operator",
            content: [
              { type: "text", text: SOURCE },
              { type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "npm test" } },
            ],
            operatorDelivery: {
              version: 1,
              sourceSha256: sha256Hex(SOURCE),
              status: "ready",
              text: PLAIN,
              checks: { plain: true, anchorsPreserved: true },
            },
          },
        },
      } as DashboardEvent,
    ]);
    expect(state.messages.map((message) => message.role)).toEqual(["assistant", "toolResult"]);
    expect(state.messages[0].content).toBe(PLAIN);
    expect(state.messages.some((message) => message.content.includes("dl-11743"))).toBe(false);
  });

  it("never exposes thinking pre-final, then restores it only for an explicit agent final", () => {
    const preFinal = reduce([
      start(),
      {
        eventType: "message_update",
        timestamp: 2,
        data: {
          message: { role: "assistant", content: [] },
          assistantMessageEvent: { type: "thinking_delta", delta: "private reasoning" },
        },
      } as DashboardEvent,
    ]);
    expect(preFinal.streamingThinking).toBe("");
    expect(preFinal.messages.some((message) => message.role === "thinking")).toBe(false);

    const state = reduceEvent(preFinal, end([
      { type: "thinking", thinking: "private reasoning" },
      { type: "text", text: SOURCE },
    ], { audience: "agent", entryId: "agent-entry", nonce: "agent-nonce" }));
    expect(state.messages.slice(-2).map((message) => [message.role, message.content])).toEqual([
      ["thinking", "private reasoning"],
      ["assistant", SOURCE],
    ]);
    expect(state.messages.find((message) => message.role === "thinking")?.audience).toBe("agent");
    expect(state.messages.at(-1)).toEqual(expect.objectContaining({
      entryId: "agent-entry",
      nonce: "agent-nonce",
    }));
  });

  it.each(["operator", "unknown"] as const)("never restores thinking for a %s final", (audience) => {
    const state = reduce([
      start(),
      end([
        { type: "thinking", thinking: "dl-11743 §2A private reasoning" },
        { type: "text", text: SOURCE },
      ], { audience, plain: PLAIN }),
    ]);
    expect(state.messages.some((message) => message.role === "thinking")).toBe(false);
    expect(state.messages.filter((message) => message.role === "assistant").map((message) => message.content)).toEqual([PLAIN]);
  });

  it("keeps repeated finalized entry delivery idempotent with stable entryId and nonce", () => {
    const finalized = end([
      { type: "thinking", thinking: "agent detail" },
      { type: "text", text: SOURCE },
      { type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "npm test" } },
    ], { audience: "agent", entryId: "entry-1", nonce: "nonce-1" });
    let state = reduce([start(), update(), toolStart(), finalized]);
    state = reduceEvent(state, finalized);

    expect(state.messages.filter((message) => message.role === "thinking")).toHaveLength(1);
    expect(state.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
    expect(state.messages.filter((message) => message.toolCallId === "tool-1")).toHaveLength(1);
    expect(state.messages.find((message) => message.role === "assistant")).toEqual(expect.objectContaining({
      entryId: "entry-1",
      nonce: "nonce-1",
    }));
  });

  it("keeps consecutive finalized agent messages distinct across a user boundary", () => {
    let state = reduce([
      start(1),
      end([{ type: "text", text: "First final" }], {
        audience: "agent", entryId: "entry-a", nonce: "nonce-a", timestamp: 2,
      }),
      {
        eventType: "message_start",
        timestamp: 3,
        data: { message: { role: "user", content: "continue" }, nonce: "user-nonce" },
      } as DashboardEvent,
      start(4),
      end([{ type: "text", text: "Second final" }], {
        audience: "agent", entryId: "entry-b", nonce: "nonce-b", timestamp: 5,
      }),
    ]);
    const finals = state.messages.filter((message) => message.role === "assistant");
    expect(finals.map((message) => [message.content, message.entryId, message.nonce])).toEqual([
      ["First final", "entry-a", "nonce-a"],
      ["Second final", "entry-b", "nonce-b"],
    ]);
  });
});
