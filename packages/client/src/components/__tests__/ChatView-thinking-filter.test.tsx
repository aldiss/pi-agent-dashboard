/**
 * Cross-layer empirical-verifier for the message-filter pipeline:
 * committed `role: "thinking"` rows in `state.messages` must reach the
 * renderer under the default filter shape.
 *
 * Closes the test-coverage gap that allowed commit 22978a8 ("preserve
 * thinking-block visibility across live→committed transition + cold-
 * replay") to ship without catching the symptom: cell pi-agent-
 * dashboard-ux-message-discoverability/v1 (commit 52f54dc) classified
 * `thinking` as a systemNotifications role + shipped
 * `DEFAULT_MESSAGE_FILTER.systemNotifications = false`. The render
 * pipeline at ChatView.tsx iterates `visibleMessages` (output of
 * `applyMessageFilter`), so committed thinking rows were silently dropped
 * before reaching the DOM. Bert's commit fixed the defaultExpanded prop
 * + cold-replay synthesis but its tests only exercised reducer state +
 * `<ThinkingBlock>` directly — they never asserted the row makes it
 * through `groupedMessages → applyMessageFilter → visibleMessages`.
 *
 * Sister-shape to:
 *   - ChatView.test.tsx (existing chat-pane integration tests; same
 *     `<ThemeProvider><ChatView state={...} /></ThemeProvider>` mount
 *     pattern + jsdom matchMedia/scrollTo stubs).
 *   - state-replay-text-tool-order.test.ts (existing reducer-state
 *     integration test).
 *   - ThinkingBlock.test.tsx (existing component-contract tests).
 *
 * See investigation: ~/.pi/orchestration-state/thinking-block-regression-
 * investigation-2026-05-25.md § "Test-coverage discipline gap" + the
 * AGENTS.md v2.0 Mega-Cluster M tier-(b) cross-layer empirical-cycle-
 * verifier discipline (the institutional learning from the Bert-commit-
 * passed-tests-but-missed-operator-symptom cycle).
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { render } from "@testing-library/react";
import React from "react";
import { ChatView } from "../ChatView.js";
import { ThemeProvider } from "../ThemeProvider.js";
import { createInitialState } from "../../lib/event-reducer.js";
import type { ToolContext } from "../tool-renderers/index.js";

const defaultToolContext: ToolContext = { editors: [] };

beforeAll(() => {
  // jsdom doesn't implement scrollTo / matchMedia. Sister-precedent
  // ChatView.test.tsx + ThinkingBlock.test.tsx.
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

function stateWithThinkingRow(content: string = "model reasoning content") {
  const state = createInitialState();
  state.messages.push({
    id: "thinking-1",
    role: "thinking",
    content,
    timestamp: Date.now(),
    startedAt: 1000,
    duration: 500,
  });
  return state;
}

describe("ChatView committed thinking-row filter visibility", () => {
  it("renders committed thinking row under the default MessageFilter (no localStorage override)", () => {
    const state = stateWithThinkingRow("first-pilot reasoning content");
    // ChatView with NO sessionId → messageFilter is { ...DEFAULT_MESSAGE_FILTER }
    // per ChatView.tsx initial useState (see ChatView.tsx ~line 306). The default
    // shape has systemNotifications: false + tierB: true; pre-fix the row would
    // be dropped by applyMessageFilter; post-fix it reaches the renderer because
    // the classifier now returns "tierB" for thinking rows.
    const { container } = render(
      <ThemeProvider>
        <ChatView state={state} toolContext={defaultToolContext} />
      </ThemeProvider>,
    );

    // ThinkingBlock renders a "Reasoning" label inside a button (see
    // ThinkingBlock.tsx). Sister-precedent ThinkingBlock.test.tsx uses
    // the same /Reasoning/ matcher. If the row was filtered out, the
    // button would not exist in the DOM.
    const reasoningButtons = Array.from(container.querySelectorAll("button"))
      .filter((b) => /Reasoning/.test(b.textContent ?? ""));
    expect(reasoningButtons.length).toBe(1);

    // Stronger structural check: ThinkingBlock's outermost wrapper carries
    // the purple-accent left border class. If the row had been filtered
    // it would be absent.
    const thinkingWrapper = container.querySelector(".border-purple-500\\/30");
    expect(thinkingWrapper).not.toBeNull();
  });

  it("does NOT hide committed thinking row when only systemNotifications is toggled (proves reclassification took effect)", () => {
    // Set localStorage so the persisted filter has systemNotifications: false
    // explicitly — same as the default but explicitly set rather than inferred
    // from no-localStorage. Pre-fix, this would also drop the thinking row
    // (because the classifier returned "systemNotifications"). Post-fix, the
    // row stays visible because the classifier returns "tierB" (which is
    // default-true). This isolates the reclassification effect from any other
    // cause.
    const sessionId = "test-session-thinking-filter";
    const persistedFilter = {
      tierA: true,
      tierB: true,
      tierC: false,
      meshChatter: true,
      toolCalls: false,
      systemNotifications: false,
    };
    window.localStorage.setItem(
      `dashboard:messageFilter:${sessionId}`,
      JSON.stringify(persistedFilter),
    );

    const state = stateWithThinkingRow("post-flip reasoning content");
    const { container } = render(
      <ThemeProvider>
        <ChatView sessionId={sessionId} state={state} toolContext={defaultToolContext} />
      </ThemeProvider>,
    );

    const reasoningButtons = Array.from(container.querySelectorAll("button"))
      .filter((b) => /Reasoning/.test(b.textContent ?? ""));
    expect(reasoningButtons.length).toBe(1);

    // Clean up localStorage so we don't pollute sibling tests.
    window.localStorage.removeItem(`dashboard:messageFilter:${sessionId}`);
  });
});
