/**
 * DOM-level regression tests for change:
 *   fix-streaming-text-vs-interactive-ui-order
 *
 * These tests drive the reducer with a live-style event sequence (without
 * firing message_end) and assert that the rendered DOM places the assistant
 * text bubble BEFORE its tool card / question dialog, matching the model's
 * content-array order during the entire tool runtime.
 *
 * Tasks covered: 6.1 (ask_user blocking), 6.1a (long-running bash), 6.2
 * (non-blocking [text, toolCall] no regression).
 */

import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import React from "react";
import { ChatView } from "../ChatView.js";
import { ThemeProvider } from "../ThemeProvider.js";
import {
  createInitialState,
  reduceEvent,
  addInteractiveRequest,
  type SessionState,
} from "../../lib/event-reducer.js";
import type { ToolContext } from "../tool-renderers/index.js";
import type { DashboardEvent } from "@blackbelt-technology/pi-dashboard-shared/types.js";

const defaultToolContext: ToolContext = { editors: [] };

afterEach(cleanup);

beforeAll(() => {
  Element.prototype.scrollTo = () => {};
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === "(prefers-color-scheme: dark)",
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
});

function applyEvents(events: DashboardEvent[]): SessionState {
  return events.reduce(reduceEvent, createInitialState());
}

function asstStart(t: number): DashboardEvent {
  return {
    eventType: "message_start",
    timestamp: t,
    data: { message: { role: "assistant", content: [] } },
  };
}
function textDelta(t: number, text: string): DashboardEvent {
  return {
    eventType: "message_update",
    timestamp: t,
    data: { message: { role: "assistant", content: [{ type: "text", text }] } },
  };
}
function toolStart(t: number, id: string, name: string): DashboardEvent {
  return {
    eventType: "tool_execution_start",
    timestamp: t,
    data: { toolCallId: id, toolName: name, args: { command: "npm test" } },
  };
}
function toolUpdate(t: number, id: string, partial: string): DashboardEvent {
  return {
    eventType: "tool_execution_update",
    timestamp: t,
    data: { toolCallId: id, partialResult: partial },
  };
}
function toolEnd(t: number, id: string): DashboardEvent {
  return {
    eventType: "tool_execution_end",
    timestamp: t,
    data: { toolCallId: id, result: "ok", status: "success" },
  };
}
function asstEnd(t: number, content: unknown[]): DashboardEvent {
  return {
    eventType: "message_end",
    timestamp: t,
    data: { message: { role: "assistant", content } },
  };
}

/** Compute the document-order index of a node within the rendered container. */
function indexOf(container: HTMLElement, target: Element | null): number {
  if (!target) return -1;
  const nodes = Array.from(container.querySelectorAll("*"));
  return nodes.indexOf(target);
}

describe("Task 6.1: ask_user blocking flow — text bubble appears above question", () => {
  it("assistant text DOM index < interactiveUi DOM index during the blocking window", () => {
    let state = applyEvents([
      asstStart(100),
      textDelta(101, "I'll ask you which path:"),
      toolStart(102, "t1", "ask_user"),
    ]);
    state = addInteractiveRequest(
      state,
      "p1",
      "select",
      { title: "pick", options: ["a", "b"] },
      "t1",
    );
    // Note: NO message_end. Question dialog is open while user thinks.

    const { container, getByText } = render(
      <ThemeProvider>
        <ChatView state={state} toolContext={defaultToolContext} />
      </ThemeProvider>,
    );

    const textBubble = getByText("I'll ask you which path:");
    const dialogNode = getByText("pick");

    expect(textBubble).toBeDefined();
    expect(dialogNode).toBeDefined();
    expect(indexOf(container, textBubble!)).toBeLessThan(
      indexOf(container, dialogNode!),
    );
  });
});

describe("Task 6.1a: long-running bash — text bubble appears above running tool card", () => {
  it("assistant text DOM index < running tool card DOM index, no streaming bubble", () => {
    let state = applyEvents([
      asstStart(100),
      textDelta(101, "All 63 tests pass. Run full test suite as final guard:"),
      toolStart(102, "t1", "bash"),
    ]);
    // Several tool_execution_update events arrive WITHOUT message_end.
    for (let i = 1; i <= 5; i++) {
      state = reduceEvent(state, toolUpdate(102 + i, "t1", `chunk #${i}`));
    }

    const { container, getByRole, getByText, queryByRole } = render(
      <ThemeProvider>
        <ChatView state={state} toolContext={defaultToolContext} />
      </ThemeProvider>,
    );

    expect(queryByRole("button", { name: /\$ npm test/ })).toBeNull();
    fireEvent.click(getByRole("button", { name: "Show all activity" }));
    const textBubble = getByText("All 63 tests pass. Run full test suite as final guard:");
    const runningButton = getByRole("button", { name: /\$ npm test/ });
    expect(state.streamingText).toBe("");

    expect(textBubble).toBeDefined();
    expect(runningButton).toBeDefined();
    expect(indexOf(container, textBubble!)).toBeLessThan(
      indexOf(container, runningButton!),
    );

    // streamingText was flushed → state.streamingText === "", so the
    // streaming bubble (the one rendered after messages.map with the pulsing
    // cursor span) is absent. Detect the cursor span — only present in the
    // streaming bubble.
    const cursors = container.querySelectorAll(".animate-pulse");
    // No streaming-text bubble cursor should be visible.
    // (Other animate-pulse usages: pendingPrompt loader. Filter to those
    // inside a div containing the live text.)
    const streamingTextCursor = Array.from(cursors).find((c) => {
      const parent = c.closest("div");
      return parent?.textContent?.includes("All 63 tests pass.") &&
        parent.querySelector("span.bg-\\[var\\(--bg-surface\\)\\]") !== null;
    });
    expect(streamingTextCursor).toBeUndefined();
  });
});

describe("Task 6.2: non-blocking [text, toolCall] — order unchanged", () => {
  it("after message_end, assistant text precedes tool card with single assistant row", () => {
    const state = applyEvents([
      asstStart(100),
      textDelta(101, "Editing file:"),
      toolStart(102, "t1", "edit"),
      toolEnd(103, "t1"),
      asstEnd(104, [
        { type: "text", text: "Editing file:" },
        { type: "toolCall", id: "t1", name: "edit" },
      ]),
    ]);

    expect(state.messages.filter((m) => m.role === "assistant")).toHaveLength(1);

    const { container, getByRole, getByText, queryByRole } = render(
      <ThemeProvider>
        <ChatView state={state} toolContext={defaultToolContext} />
      </ThemeProvider>,
    );

    expect(queryByRole("button", { name: /Edit file/ })).toBeNull();
    fireEvent.click(getByRole("button", { name: "Show all activity" }));
    const textBubble = getByText("Editing file:");
    const toolButton = getByRole("button", { name: /Edit file/ });

    expect(textBubble).toBeDefined();
    expect(toolButton).toBeDefined();
    expect(indexOf(container, textBubble!)).toBeLessThan(
      indexOf(container, toolButton!),
    );
  });
});
