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

function stateWithThinkingRow(
  content: string = "model reasoning content",
  audience?: "operator" | "agent" | "unknown",
) {
  const state = createInitialState();
  state.messages.push({
    id: "thinking-1",
    role: "thinking",
    content,
    timestamp: Date.now(),
    startedAt: 1000,
    duration: 500,
    ...(audience ? { audience } : {}),
  });
  return state;
}

function stateWithThinkingThenAssistant(
  thinkingContent: string = "model reasoning content",
  assistantContent: string = "final assistant text",
) {
  const state = createInitialState();
  state.messages.push({
    id: "thinking-1",
    role: "thinking",
    content: thinkingContent,
    timestamp: Date.now() - 100,
    startedAt: 1000,
    duration: 500,
  });
  state.messages.push({
    id: "msg-1",
    role: "assistant",
    content: assistantContent,
    timestamp: Date.now(),
  });
  return state;
}

function stateWithThinkingThenTurnSeparator(
  thinkingContent: string = "model reasoning content",
) {
  const state = createInitialState();
  state.messages.push({
    id: "thinking-1",
    role: "thinking",
    content: thinkingContent,
    timestamp: Date.now() - 100,
    startedAt: 1000,
    duration: 500,
  });
  state.messages.push({
    id: "sep-1",
    role: "turnSeparator",
    content: "",
    timestamp: Date.now(),
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

  it("keeps finalized agent thinking aligned with the Agent-only chat toggle", () => {
    const sessionId = "agent-thinking-filter";
    const state = stateWithThinkingRow("dl-11743 §2A private reasoning", "agent");
    window.localStorage.setItem(
      `dashboard:messageFilter:${sessionId}`,
      JSON.stringify({
        tierA: true,
        tierB: true,
        tierC: false,
        meshChatter: false,
        toolCalls: false,
        systemNotifications: false,
      }),
    );
    const hidden = render(
      <ThemeProvider>
        <ChatView sessionId={sessionId} state={state} toolContext={defaultToolContext} />
      </ThemeProvider>,
    );
    expect(Array.from(hidden.container.querySelectorAll("button"))
      .some((button) => /Reasoning/.test(button.textContent ?? ""))).toBe(false);
    expect(hidden.container.textContent).not.toContain("dl-11743");
    hidden.unmount();

    window.localStorage.setItem(
      `dashboard:messageFilter:${sessionId}`,
      JSON.stringify({
        tierA: true,
        tierB: true,
        tierC: false,
        meshChatter: true,
        toolCalls: false,
        systemNotifications: false,
      }),
    );
    const revealed = render(
      <ThemeProvider>
        <ChatView sessionId={sessionId} state={state} toolContext={defaultToolContext} />
      </ThemeProvider>,
    );
    expect(Array.from(revealed.container.querySelectorAll("button"))
      .some((button) => /Reasoning/.test(button.textContent ?? ""))).toBe(true);
    window.localStorage.removeItem(`dashboard:messageFilter:${sessionId}`);
  });
});

/**
 * Auto-collapse contract for committed thinking rows.
 *
 * Operator intent verbatim (chat 2026-05-25, typos preserved per AGENTS.md
 * Pattern 87 byte-identical discipline): "the thinking block sgould fold
 * once the next message to the user is rendered. right now it is always
 * open".
 *
 * Mechanism (ChatView.tsx committed thinking branch): compute
 * `isLatestThinking = (no subsequent non-thinking, non-turnSeparator item
 * exists in visibleMessages after this row)`. Pass
 * `defaultExpanded={isLatestThinking}` + key-suffix `-latest` | `-older`
 * so the latest→older transition forces remount with the new
 * `defaultExpanded=false`, auto-collapsing the block. Turn separators are
 * layout-only and do not count as "model moved on".
 *
 * Sister to ChatView.tsx commit 22978a8 (Bert sticky-expanded fix) +
 * commit 2283c20 (thinking-tierB reclassification) + Mega-Cluster M v2.0
 * tier-(a) empirical-cycle-pass discipline.
 */
describe("ChatView committed thinking-row auto-collapse contract", () => {
  it("keeps the thinking row expanded when it is the latest message", () => {
    const content = "latest-thinking reasoning content";
    const state = stateWithThinkingRow(content);
    const { container } = render(
      <ThemeProvider>
        <ChatView state={state} toolContext={defaultToolContext} />
      </ThemeProvider>,
    );

    // Reasoning button still in DOM (row not filtered out).
    const reasoningButtons = Array.from(container.querySelectorAll("button"))
      .filter((b) => /Reasoning/.test(b.textContent ?? ""));
    expect(reasoningButtons.length).toBe(1);

    // Body content visible — ThinkingBlock renders the content only inside
    // the expanded branch (see ThinkingBlock.tsx). If `defaultExpanded`
    // were false, the body wouldn't be in the DOM.
    expect(container.textContent ?? "").toContain(content);
  });

  it("auto-collapses the thinking row when a subsequent assistant message exists", () => {
    const thinkingContent = "older-thinking reasoning content";
    const assistantContent = "final assistant message body";
    const state = stateWithThinkingThenAssistant(thinkingContent, assistantContent);
    const { container } = render(
      <ThemeProvider>
        <ChatView state={state} toolContext={defaultToolContext} />
      </ThemeProvider>,
    );

    // Reasoning header button is still present (row not filtered out).
    const reasoningButtons = Array.from(container.querySelectorAll("button"))
      .filter((b) => /Reasoning/.test(b.textContent ?? ""));
    expect(reasoningButtons.length).toBe(1);

    // The collapsed-body discriminator: ThinkingBlock only renders
    // `content` inside the `{expanded && (...)}` branch. With
    // `defaultExpanded=false` the body MUST NOT appear in the DOM.
    expect(container.textContent ?? "").not.toContain(thinkingContent);

    // Sanity — the assistant message is rendered (proves the state
    // shape reached the renderer; rules out the row being filtered
    // away as a no-op success).
    expect(container.textContent ?? "").toContain(assistantContent);
  });

  it("does NOT auto-collapse the thinking row when only a turnSeparator follows it", () => {
    // Turn separators are layout-only borders; the model has not yet
    // emitted text-to-user, so the thinking block should stay expanded.
    const content = "separator-only reasoning content";
    const state = stateWithThinkingThenTurnSeparator(content);
    const { container } = render(
      <ThemeProvider>
        <ChatView state={state} toolContext={defaultToolContext} />
      </ThemeProvider>,
    );

    const reasoningButtons = Array.from(container.querySelectorAll("button"))
      .filter((b) => /Reasoning/.test(b.textContent ?? ""));
    expect(reasoningButtons.length).toBe(1);

    // Body is still in the DOM — the row remains expanded.
    expect(container.textContent ?? "").toContain(content);
  });
});
