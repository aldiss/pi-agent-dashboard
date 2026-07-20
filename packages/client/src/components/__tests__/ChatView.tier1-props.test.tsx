/**
 * ChatView Tier-1 props — `defaultFilter` (filter-param M-fix) + `disableToolGrouping` (M11).
 *
 * Locks in the two additive props the thread message-lane depends on:
 *   • `defaultFilter` — a surface baseline (`tierC:true`) that flows through
 *     init / "is default" / Reset / banner, so a thread default is NOT
 *     mislabeled non-default (which would wrongly show the banner Reset).
 *   • `disableToolGrouping` — the 3-identical-tool-call run renders as 3 rows,
 *     NOT one collapsed `collapsed-group` pill.
 *
 * jsdom scrollTo/matchMedia stubs mirror ChatView.show-all-activity.test.tsx.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import React from "react";
import { ChatView } from "../ChatView.js";
import { ThemeProvider } from "../ThemeProvider.js";
import { createInitialState } from "../../lib/event-reducer.js";
import { DEFAULT_MESSAGE_FILTER, type MessageFilter } from "../../lib/message-filter-storage.js";
import type { ToolContext } from "../tool-renderers/index.js";

const toolContext: ToolContext = { editors: [] };
const THREAD_DEFAULT: MessageFilter = { ...DEFAULT_MESSAGE_FILTER, tierC: true };

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

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

/** Three identical consecutive bash toolResults (would collapse if grouped). */
function stateWithThreeIdenticalTools() {
  const state = createInitialState();
  for (let i = 0; i < 3; i++) {
    state.messages.push({
      id: `tool-${i}`,
      role: "toolResult",
      content: "bash",
      toolName: "bash",
      toolCallId: `tc-${i}`,
      args: { command: "curl -s localhost:8000/health" },
      toolStatus: "complete",
      result: "ok",
      timestamp: Date.now() + i,
    });
  }
  return state;
}

describe("ChatView disableToolGrouping (M11)", () => {
  it("collapses 3 identical tool calls into a group by DEFAULT (grouping on)", () => {
    // Reveal tool rows (defaultFilter toolCalls:true) so the grouping is
    // observable — the default filter hides tool rows, which would empty the
    // DOM before any group could form. This isolates the GROUPING behavior.
    const showTools: MessageFilter = { ...DEFAULT_MESSAGE_FILTER, toolCalls: true };
    const { container } = render(
      <ThemeProvider>
        <ChatView state={stateWithThreeIdenticalTools()} toolContext={toolContext} defaultFilter={showTools} />
      </ThemeProvider>,
    );
    // Control: with grouping on, the 3 identical bash rows collapse to one pill.
    expect(container.querySelector('[data-testid="collapsed-group"]')).not.toBeNull();
  });

  it("does NOT collapse them when disableToolGrouping is set (native rows survive)", () => {
    const showTools: MessageFilter = { ...DEFAULT_MESSAGE_FILTER, toolCalls: true };
    const { container } = render(
      <ThemeProvider>
        <ChatView state={stateWithThreeIdenticalTools()} toolContext={toolContext} defaultFilter={showTools} disableToolGrouping />
      </ThemeProvider>,
    );
    expect(container.querySelector('[data-testid="collapsed-group"]')).toBeNull();
  });
});

describe("ChatView defaultFilter (filter-param M-fix)", () => {
  it("treats a tierC-on filter as DEFAULT when defaultFilter has tierC:true (no spurious banner Reset)", () => {
    // A tierB toolResult is hidden under the thread default (toolCalls:false),
    // so the banner appears — but because the filter EQUALS the thread default,
    // the banner's Reset must NOT render (it is already at its baseline).
    const state = createInitialState();
    state.messages.push({ id: "u", role: "user", content: "hi", timestamp: Date.now() });
    state.messages.push({
      id: "t", role: "toolResult", content: "bash", toolName: "bash", toolCallId: "tc",
      args: { command: "ls" }, toolStatus: "complete", result: "ok", timestamp: Date.now(),
    });
    const { queryByTestId } = render(
      <ThemeProvider>
        <ChatView state={state} toolContext={toolContext} defaultFilter={THREAD_DEFAULT} disableToolGrouping />
      </ThemeProvider>,
    );
    // Banner present (a tool row is hidden), but at-baseline → no Reset button.
    expect(queryByTestId("message-filter-banner")).not.toBeNull();
    expect(queryByTestId("message-filter-banner-reset")).toBeNull();
  });
});
