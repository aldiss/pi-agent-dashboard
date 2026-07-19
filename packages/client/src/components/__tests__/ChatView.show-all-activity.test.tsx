/**
 * A2 "Show all activity" affordance — discoverability + native-parity reveal.
 *
 * Root cause (driver-confirmed): DEFAULT_MESSAGE_FILTER hides toolCalls +
 * systemNotifications, so on a fresh device tool + subagent rows are hidden
 * yet `isFilterActive` is FALSE (hiding-tools IS the default). The old banner
 * gated on `isFilterActive`, so the operator got zero hint that rows were
 * hidden. This test locks in the fix:
 *
 *   (a) the affordance renders under the DEFAULT filter whenever rows are
 *       actually hidden (hiddenCount > 0), NOT only when the filter differs
 *       from default.
 *   (b) the "Show all activity" action applies an all-categories-on filter
 *       so the previously-hidden tool/subagent rows reach the DOM.
 *
 * Sister-shape to ChatView.test.tsx / ChatView-thinking-filter.test.tsx
 * (same `<ThemeProvider><ChatView state={...} /></ThemeProvider>` mount +
 * jsdom scrollTo/matchMedia stubs).
 *
 * CC BUILD BRIEF — Dashboard Part-A (A2), supervised by Vantage.
 */

import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import React from "react";
import { ChatView } from "../ChatView.js";
import { ThemeProvider } from "../ThemeProvider.js";
import { createInitialState } from "../../lib/event-reducer.js";
import type { ToolContext } from "../tool-renderers/index.js";

const defaultToolContext: ToolContext = { editors: [] };

beforeAll(() => {
  // jsdom doesn't implement scrollTo / matchMedia. Sister-precedent
  // ChatView.test.tsx + ChatView-thinking-filter.test.tsx.
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
  // Unmount prior render trees so document.body-scoped queries
  // (getByTestId/queryByTestId) don't see a previous case's DOM.
  cleanup();
  // Isolate per-session persisted filters between cases.
  window.localStorage.clear();
});

/**
 * State with one visible narrative row (user text → meshChatter, default ON)
 * plus one hidden tool row (toolResult → toolCalls, default OFF). Under the
 * DEFAULT filter: visible = 1, grouped = 2, hiddenCount = 1 → affordance must
 * appear even though `isFilterActive` is false. A single toolResult never
 * groups (groupConsecutiveToolCalls needs >= 3), so it emits verbatim.
 */
function stateWithHiddenToolRow() {
  const state = createInitialState();
  state.messages.push({
    id: "u-1",
    role: "user",
    content: "run the build please",
    timestamp: Date.now() - 100,
  });
  state.messages.push({
    id: "tool-1",
    role: "toolResult",
    content: "bash",
    toolName: "bash",
    toolCallId: "tc-1",
    args: { command: "npm run build" },
    toolStatus: "complete",
    result: "build ok",
    timestamp: Date.now(),
  });
  return state;
}

describe("ChatView A2 — Show all activity affordance", () => {
  it("renders the affordance under the DEFAULT filter when tool rows are hidden", () => {
    // No sessionId → messageFilter = { ...DEFAULT_MESSAGE_FILTER }. The default
    // hides toolCalls, so hiddenCount === 1 while isFilterActive === false.
    const { getByTestId, queryByTestId } = render(
      <ThemeProvider>
        <ChatView state={stateWithHiddenToolRow()} toolContext={defaultToolContext} />
      </ThemeProvider>,
    );

    // Banner is present despite the filter being the default shape.
    const banner = getByTestId("message-filter-banner");
    expect(banner).not.toBeNull();
    // Communicates what is hidden (count of hidden tool & subagent steps).
    expect(banner.textContent ?? "").toMatch(/1/);
    expect(banner.textContent ?? "").toMatch(/hidden/i);
    // The primary reveal action exists.
    expect(queryByTestId("message-filter-show-all")).not.toBeNull();
  });

  it("does NOT render the affordance when nothing is hidden", () => {
    // Only a visible user row → hiddenCount === 0 → no banner.
    const state = createInitialState();
    state.messages.push({
      id: "u-1",
      role: "user",
      content: "hello",
      timestamp: Date.now(),
    });
    const { queryByTestId } = render(
      <ThemeProvider>
        <ChatView state={state} toolContext={defaultToolContext} />
      </ThemeProvider>,
    );
    expect(queryByTestId("message-filter-banner")).toBeNull();
  });

  it("'Show all activity' applies an all-categories-on filter, revealing the hidden tool row", () => {
    const { container, getByTestId, queryByTestId } = render(
      <ThemeProvider>
        <ChatView state={stateWithHiddenToolRow()} toolContext={defaultToolContext} />
      </ThemeProvider>,
    );

    // Pre-click: the hidden tool row's summary is NOT in the DOM (ToolCallStep
    // renders "$ npm run build" for a bash tool — see ChatView.test.tsx).
    expect(container.textContent ?? "").not.toContain("$ npm run build");

    fireEvent.click(getByTestId("message-filter-show-all"));

    // Post-click: the tool row is revealed (all categories on → nothing filtered).
    expect(container.textContent ?? "").toContain("$ npm run build");
    // And the affordance dismisses itself because hiddenCount is now 0.
    expect(queryByTestId("message-filter-banner")).toBeNull();
  });
});
