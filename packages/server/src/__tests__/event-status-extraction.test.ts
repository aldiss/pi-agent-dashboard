import { describe, it, expect } from "vitest";
import { extractSessionUpdates, extractAgentEndError } from "../event-status-extraction.js";
import type { DashboardEvent } from "@blackbelt-technology/pi-dashboard-shared/types.js";

function makeEvent(eventType: string, data: Record<string, unknown> = {}): DashboardEvent {
  return { eventType, timestamp: Date.now(), data: { type: eventType, ...data } };
}

describe("extractSessionUpdates", () => {
  it("should return streaming status on agent_start", () => {
    const updates = extractSessionUpdates(makeEvent("agent_start"));
    expect(updates).toEqual({ status: "streaming", currentTool: null });
  });

  it("should return idle status on agent_end", () => {
    const updates = extractSessionUpdates(makeEvent("agent_end"));
    expect(updates).toEqual({ status: "idle", currentTool: null });
  });

  it("should return currentTool on tool_execution_start", () => {
    const updates = extractSessionUpdates(makeEvent("tool_execution_start", { toolName: "Read" }));
    expect(updates).toEqual({ currentTool: "Read" });
  });

  it("should clear currentTool on tool_execution_end", () => {
    const updates = extractSessionUpdates(makeEvent("tool_execution_end", { toolName: "Read" }));
    expect(updates).toEqual({ currentTool: null });
  });

  it("should extract model from model_select event", () => {
    const updates = extractSessionUpdates(
      makeEvent("model_select", {
        model: { provider: "anthropic", id: "claude-opus-4-6" },
      })
    );
    expect(updates).toEqual({ model: "anthropic/claude-opus-4-6" });
  });

  it("should extract model and thinkingLevel from model_select event", () => {
    const updates = extractSessionUpdates(
      makeEvent("model_select", {
        model: { provider: "anthropic", id: "claude-opus-4-6" },
        thinkingLevel: "high",
      })
    );
    expect(updates).toEqual({ model: "anthropic/claude-opus-4-6", thinkingLevel: "high" });
  });

  it("should return null for model_select without model data", () => {
    expect(extractSessionUpdates(makeEvent("model_select"))).toBeNull();
  });

  it("should return null for unrelated events", () => {
    expect(extractSessionUpdates(makeEvent("message_update"))).toBeNull();
    expect(extractSessionUpdates(makeEvent("session_compact"))).toBeNull();
    expect(extractSessionUpdates(makeEvent("turn_start"))).toBeNull();
  });
});

/**
 * Canonical server-side error detection over the terminal-message shape.
 * Mirrors the client reference `extractAgentEndError` (event-reducer.ts).
 * NOTE: these fixtures use the REAL bridge-forwarded shape — the pi event's
 * `messages[]` with a terminal `stopReason: "error"` — NOT the invented
 * `{ error }` payload the legacy unread branch checked (FATAL 1A).
 * See change: build-2-dashboard-v3.
 */
describe("extractAgentEndError", () => {
  it("returns the errorMessage when the terminal message stopReason is 'error'", () => {
    const event = makeEvent("agent_end", {
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", stopReason: "error", errorMessage: "rate limit exceeded" },
      ],
    });
    expect(extractAgentEndError(event)).toBe("rate limit exceeded");
  });

  it("returns a generic fallback when stopReason is 'error' but errorMessage is absent", () => {
    const event = makeEvent("agent_end", {
      messages: [{ role: "assistant", stopReason: "error" }],
    });
    expect(extractAgentEndError(event)).toBe("An unknown error occurred");
  });

  it("returns undefined when the terminal message ended normally", () => {
    const event = makeEvent("agent_end", {
      messages: [{ role: "assistant", stopReason: "end_turn", content: "done" }],
    });
    expect(extractAgentEndError(event)).toBeUndefined();
  });

  it("returns undefined for the invented { error } payload shape (must NOT false-positive)", () => {
    // This is the WRONG shape the legacy branch checked. The canonical
    // predicate reads `messages[last].stopReason`, so a bare `{ error }`
    // payload with no messages array must NOT be treated as an error.
    const event = makeEvent("agent_end", { error: "rate limit exceeded" });
    expect(extractAgentEndError(event)).toBeUndefined();
  });

  it("returns undefined when messages is missing or empty", () => {
    expect(extractAgentEndError(makeEvent("agent_end"))).toBeUndefined();
    expect(extractAgentEndError(makeEvent("agent_end", { messages: [] }))).toBeUndefined();
  });

  it("returns undefined for non-agent_end events even with an errored terminal message", () => {
    const event = makeEvent("turn_end", {
      messages: [{ role: "assistant", stopReason: "error", errorMessage: "boom" }],
    });
    expect(extractAgentEndError(event)).toBeUndefined();
  });
});
