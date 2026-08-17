import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import React from "react";
import { ChatView } from "../ChatView.js";
import { ThemeProvider } from "../ThemeProvider.js";
import { createInitialState, type ChatMessage, type PendingPrompt } from "../../lib/event-reducer.js";
import type { ToolContext } from "../tool-renderers/index.js";

const defaultToolContext: ToolContext = { editors: [] };

beforeAll(() => {
  // jsdom doesn't implement scrollTo
  Element.prototype.scrollTo = () => {};
  // jsdom doesn't implement matchMedia
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

function stateWithMessages(messages: Array<{ id: string; role: "user" | "assistant"; content: string }>) {
  const state = createInitialState();
  for (const msg of messages) {
    state.messages.push({ ...msg, timestamp: Date.now() });
  }
  return state;
}

function stateWithToolMessage(overrides: Partial<ChatMessage> = {}) {
  const state = createInitialState();
  state.messages.push({
    id: "tool-1",
    role: "toolResult",
    content: "bash",
    toolName: "bash",
    toolCallId: "tc-1",
    args: { command: "ls -la" },
    toolStatus: "complete",
    result: "file1\nfile2",
    timestamp: Date.now(),
    ...overrides,
  });
  return state;
}

describe("ChatView", () => {
  it("loading ≠ empty: zero messages + replay NOT complete → 'Loading messages…' (build-2 fix-cycle MAJOR 2)", () => {
    const state = createInitialState(); // replayComplete undefined = still loading
    const { container } = render(<ThemeProvider><ChatView state={state} toolContext={defaultToolContext} /></ThemeProvider>);
    expect(container.querySelector('[data-testid="chat-loading"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="chat-empty"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-data-unavailable"]')).toBeNull();
  });

  it("truthful empty: zero messages + replay COMPLETE → 'No messages yet'", () => {
    const state = { ...createInitialState(), replayComplete: true };
    const { container } = render(<ThemeProvider><ChatView state={state} toolContext={defaultToolContext} /></ThemeProvider>);
    expect(container.querySelector('[data-testid="chat-empty"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="chat-loading"]')).toBeNull();
  });

  it("data-unavailable wins over loading/empty when the transcript failed to load", () => {
    const state = { ...createInitialState(), replayComplete: true };
    const { container } = render(<ThemeProvider><ChatView state={state} toolContext={defaultToolContext} dataUnavailable /></ThemeProvider>);
    expect(container.querySelector('[data-testid="chat-data-unavailable"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="chat-empty"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-loading"]')).toBeNull();
  });

  it("renders user message with copy buttons", () => {
    const state = stateWithMessages([
      { id: "1", role: "user", content: "Hello **world**" },
    ]);
    const { container } = render(<ThemeProvider><ChatView state={state} toolContext={defaultToolContext} /></ThemeProvider>);
    const mdBtn = container.querySelector('button[title="Copy as Markdown"]');
    const plainBtn = container.querySelector('button[title="Copy as plain text"]');
    expect(mdBtn).not.toBeNull();
    expect(plainBtn).not.toBeNull();
  });

  it("renders assistant message with copy buttons", () => {
    const state = stateWithMessages([
      { id: "1", role: "assistant", content: "Here is the answer" },
    ]);
    const { container } = render(<ThemeProvider><ChatView state={state} toolContext={defaultToolContext} /></ThemeProvider>);
    const mdBtn = container.querySelector('button[title="Copy as Markdown"]');
    const plainBtn = container.querySelector('button[title="Copy as plain text"]');
    expect(mdBtn).not.toBeNull();
    expect(plainBtn).not.toBeNull();
  });

  it("renders plain English in place and reveals the untouched original in one gesture", () => {
    const state = createInitialState();
    state.messages.push({
      id: "assistant-1",
      role: "assistant",
      content: "The internal handoff remains blocked.",
      translation: "The work transfer remains blocked.",
      translationState: "ready",
      entryId: "entry-a1",
      timestamp: 1,
    });

    const { container } = render(
      <ThemeProvider><ChatView state={state} toolContext={defaultToolContext} translationEnabled /></ThemeProvider>,
    );

    expect(container.textContent).toContain("The work transfer remains blocked.");
    expect(container.textContent).not.toContain("The internal handoff remains blocked.");
    const originalButton = container.querySelector('button[title="Show original"]');
    expect(originalButton).not.toBeNull();

    fireEvent.click(originalButton!);

    expect(container.textContent).toContain("The internal handoff remains blocked.");
    expect(container.querySelector('button[title="Show plain English"]')).not.toBeNull();
  });

  it("shows the original plus a readable reason when translation fails", () => {
    const state = createInitialState();
    state.messages.push({
      id: "assistant-1",
      role: "assistant",
      content: "The original remains visible.",
      translationState: "failed",
      translationFailureReason: "timeout",
      entryId: "entry-a1",
      timestamp: 1,
    });

    const { container } = render(
      <ThemeProvider><ChatView state={state} toolContext={defaultToolContext} translationEnabled /></ThemeProvider>,
    );

    expect(container.textContent).toContain("The original remains visible.");
    expect(container.querySelector('[data-testid="translation-unavailable"]')?.textContent).toMatch(/failed.*timed out/i);
    expect(container.querySelector('button[title="Show original"]')).toBeNull();
  });

  it("translation is OFF by default and makes no translated rendering visible", () => {
    const state = createInitialState();
    state.messages.push({
      id: "assistant-1",
      role: "assistant",
      content: "The internal handoff remains blocked.",
      translation: "The work transfer remains blocked.",
      translationState: "ready",
      entryId: "entry-a1",
      timestamp: 1,
    });

    const { container } = render(
      <ThemeProvider><ChatView sessionId="s1" state={state} toolContext={defaultToolContext} onTranslationToggle={vi.fn()} /></ThemeProvider>,
    );

    expect(container.textContent).toContain("The internal handoff remains blocked.");
    expect(container.textContent).not.toContain("The work transfer remains blocked.");
    expect(container.querySelector('[data-testid="session-translation-toggle"]')?.getAttribute("aria-pressed")).toBe("false");
  });

  it("disabling session translation restores the original", () => {
    const state = createInitialState();
    state.messages.push({
      id: "assistant-1",
      role: "assistant",
      content: "The internal handoff remains blocked.",
      translation: "The work transfer remains blocked.",
      translationState: "ready",
      entryId: "entry-a1",
      timestamp: 1,
    });
    const onTranslationToggle = vi.fn();
    const view = render(
      <ThemeProvider>
        <ChatView sessionId="s1" state={state} toolContext={defaultToolContext} translationEnabled onTranslationToggle={onTranslationToggle} />
      </ThemeProvider>,
    );
    expect(view.container.textContent).toContain("The work transfer remains blocked.");

    fireEvent.click(view.container.querySelector('[data-testid="session-translation-toggle"]')!);
    expect(onTranslationToggle).toHaveBeenCalledWith(false);

    view.rerender(
      <ThemeProvider>
        <ChatView sessionId="s1" state={state} toolContext={defaultToolContext} translationEnabled={false} onTranslationToggle={onTranslationToggle} />
      </ThemeProvider>,
    );
    expect(view.container.textContent).toContain("The internal handoff remains blocked.");
    expect(view.container.textContent).not.toContain("The work transfer remains blocked.");
  });

  it("shows distinct immediate pending, unchanged, applied, and failed states without inert Original buttons", () => {
    const state = createInitialState();
    state.messages.push(
      { id: "pending", role: "assistant", content: "Pending original message long enough for translation.", entryId: "entry-pending", timestamp: 1 },
      { id: "unchanged", role: "assistant", content: "Already plain original message.", translationState: "unchanged", entryId: "entry-unchanged", timestamp: 2 },
      { id: "ready", role: "assistant", content: "Applied original message.", translation: "Applied plain-English message.", translationState: "ready", entryId: "entry-ready", timestamp: 3 },
      { id: "failed", role: "assistant", content: "Failed original message.", translationState: "failed", translationFailureReason: "timeout", entryId: "entry-failed", timestamp: 4 },
    );

    const { container } = render(
      <ThemeProvider><ChatView sessionId="s1" state={state} toolContext={defaultToolContext} translationEnabled onTranslationToggle={vi.fn()} /></ThemeProvider>,
    );

    expect(container.querySelector('[data-translation-status="pending"]')?.textContent).toMatch(/waiting/i);
    expect(container.querySelector('[data-translation-status="unchanged"]')?.textContent).toMatch(/already plain/i);
    expect(container.querySelector('[data-translation-status="ready"]')?.textContent).toMatch(/applied/i);
    expect(container.querySelector('[data-translation-status="failed"]')?.textContent).toMatch(/failed.*timed out/i);
    expect(container.querySelectorAll('button[title="Show original"]')).toHaveLength(1);
  });

  it("limits history waiting to the newest 20 and advances a future live row from pending to applied", async () => {
    const historyState = createInitialState();
    historyState.replayComplete = true;
    historyState.messages.push(
      ...Array.from({ length: 30 }, (_, index) => ({
        id: `history-${index}`,
        role: "assistant" as const,
        content: `Historical assistant message ${index}`,
        entryId: `entry-history-${index}`,
        timestamp: index,
      })),
    );

    const view = render(
      <ThemeProvider>
        <ChatView sessionId="s1" state={historyState} toolContext={defaultToolContext} translationEnabled onTranslationToggle={vi.fn()} />
      </ThemeProvider>,
    );

    await vi.waitFor(() => {
      expect(view.container.querySelectorAll('[data-translation-status="pending"]')).toHaveLength(20);
    });
    for (let index = 0; index < 10; index += 1) {
      expect(
        view.container.querySelector(`[data-entry-id="entry-history-${index}"] [data-translation-status="pending"]`),
      ).toBeNull();
    }
    for (let index = 10; index < 30; index += 1) {
      expect(
        view.container.querySelector(`[data-entry-id="entry-history-${index}"] [data-translation-status="pending"]`),
      ).not.toBeNull();
    }

    const livePendingState = {
      ...historyState,
      messages: [
        ...historyState.messages,
        {
          id: "live-30",
          role: "assistant" as const,
          content: "Future live assistant message",
          entryId: "entry-live-30",
          timestamp: 30,
        },
      ],
    };
    view.rerender(
      <ThemeProvider>
        <ChatView sessionId="s1" state={livePendingState} toolContext={defaultToolContext} translationEnabled onTranslationToggle={vi.fn()} />
      </ThemeProvider>,
    );

    await vi.waitFor(() => {
      expect(
        view.container.querySelector('[data-entry-id="entry-live-30"] [data-translation-status="pending"]'),
      ).not.toBeNull();
      expect(view.container.querySelectorAll('[data-translation-status="pending"]')).toHaveLength(21);
    });

    const liveReadyState = {
      ...livePendingState,
      messages: livePendingState.messages.map((message) => message.id === "live-30"
        ? {
            ...message,
            translation: "Future live plain-English message",
            translationState: "ready" as const,
          }
        : message),
    };
    view.rerender(
      <ThemeProvider>
        <ChatView sessionId="s1" state={liveReadyState} toolContext={defaultToolContext} translationEnabled onTranslationToggle={vi.fn()} />
      </ThemeProvider>,
    );

    await vi.waitFor(() => {
      const liveRow = view.container.querySelector('[data-entry-id="entry-live-30"]')!;
      expect(liveRow.querySelector('[data-translation-status="pending"]')).toBeNull();
      expect(liveRow.querySelector('[data-translation-status="ready"]')?.textContent).toMatch(/applied/i);
      expect(liveRow.textContent).toContain("Future live plain-English message");
      expect(view.container.querySelectorAll('[data-translation-status="pending"]')).toHaveLength(20);
    });
  });

  it("renders toolResult messages using ToolCallStep", () => {
    const state = stateWithToolMessage();
    const { container } = render(<ThemeProvider><ChatView state={state} toolContext={defaultToolContext} /></ThemeProvider>);

    // Should show the tool summary (ToolCallStep renders a button with summary text)
    const button = container.querySelector("button");
    expect(button).not.toBeNull();
    expect(button!.textContent).toContain("$ ls -la");

    // Should show status icon (SVG check for complete)
    expect(button!.querySelector("svg")).not.toBeNull();
  });

  it("renders expandable tool call with args and result", () => {
    const state = stateWithToolMessage();
    const { container } = render(<ThemeProvider><ChatView state={state} toolContext={defaultToolContext} /></ThemeProvider>);

    // Click to expand
    const button = container.querySelector("button")!;
    fireEvent.click(button);

    // Should show args and result in expanded view
    const expanded = container.querySelector(".bg-\\[var\\(--bg-secondary\\)\\]");
    expect(expanded).not.toBeNull();
    expect(expanded!.textContent).toContain("ls -la");
    expect(expanded!.textContent).toContain("file1");
    expect(expanded!.textContent).toContain("file2");
  });

  it("renders running tool call with spinner icon", () => {
    const state = stateWithToolMessage({ toolStatus: "running" });
    const { container } = render(<ThemeProvider><ChatView state={state} toolContext={defaultToolContext} /></ThemeProvider>);

    const button = container.querySelector("button");
    expect(button!.querySelector("svg")).not.toBeNull();
  });

  it("renders error tool call with error icon", () => {
    const state = stateWithToolMessage({ toolStatus: "error" });
    const { container } = render(<ThemeProvider><ChatView state={state} toolContext={defaultToolContext} /></ThemeProvider>);

    const button = container.querySelector("button");
    expect(button!.querySelector("svg")).not.toBeNull();
  });

  it("renders user message bubble with subtle blue tint and accent border", () => {
    const state = stateWithMessages([
      { id: "1", role: "user", content: "Hello" },
    ]);
    const { container } = render(<ThemeProvider><ChatView state={state} toolContext={defaultToolContext} /></ThemeProvider>);
    const userBubble = container.querySelector(".bg-blue-500\\/10");
    expect(userBubble).not.toBeNull();
    expect(userBubble?.className).toContain("border-l-blue-400");
    expect(userBubble?.className).toContain("rounded-xl");
    expect(userBubble?.className).toContain("shadow-md");
  });

  it("renders assistant message bubble with 3D styling", () => {
    const state = stateWithMessages([
      { id: "1", role: "assistant", content: "Hi there" },
    ]);
    const { container } = render(<ThemeProvider><ChatView state={state} toolContext={defaultToolContext} /></ThemeProvider>);
    const assistantBubble = container.querySelector(".bg-\\[var\\(--bg-tertiary\\)\\]");
    expect(assistantBubble?.className).toContain("border-[var(--border-subtle)]");
    expect(assistantBubble?.className).toContain("rounded-xl");
    expect(assistantBubble?.className).toContain("shadow-md");
  });

  it("renders copy button divider in message bubbles", () => {
    const state = stateWithMessages([
      { id: "1", role: "assistant", content: "Test message" },
    ]);
    const { container } = render(<ThemeProvider><ChatView state={state} toolContext={defaultToolContext} /></ThemeProvider>);
    // The divider between content and copy buttons
    const divider = container.querySelector(".border-t.border-\\[var\\(--border-secondary\\)\\]");
    expect(divider).not.toBeNull();
  });

  it("renders tool call step with left accent border", () => {
    const state = stateWithToolMessage();
    const { container } = render(<ThemeProvider><ChatView state={state} toolContext={defaultToolContext} /></ThemeProvider>);
    const toolStep = container.querySelector(".border-l-2.border-\\[var\\(--border-secondary\\)\\]");
    expect(toolStep).not.toBeNull();
  });

  it("does not show copy buttons on streaming text", () => {
    const state = createInitialState();
    state.streamingText = "Partial response...";
    const { container } = render(<ThemeProvider><ChatView state={state} toolContext={defaultToolContext} /></ThemeProvider>);
    // Streaming bubble doesn't have message-level copy buttons
    const mdBtns = container.querySelectorAll('button[title="Copy as Markdown"]');
    expect(mdBtns.length).toBe(0);
  });

  it("renders optimistic pending prompt card (lifts in, no spinner)", () => {
    const state = createInitialState();
    state.pendingPrompt = { text: "Fix the bug" };
    const { getByTestId } = render(<ThemeProvider><ChatView state={state} toolContext={defaultToolContext} /></ThemeProvider>);
    const card = getByTestId("pending-prompt-card");
    expect(card).not.toBeNull();
    expect(card.textContent).toContain("Fix the bug");
    // Deep-slickness motion (Wave 1): the optimistic bubble now LIFTS into place
    // (smooth spring, translateY→0 + fade) instead of showing a spinner — the
    // motion IS the feedback. The old `.animate-spin` spinner was removed.
    const spinner = card.querySelector(".animate-spin");
    expect(spinner).toBeNull();
  });

  it("does not render pending prompt card when pendingPrompt is undefined", () => {
    const state = createInitialState();
    const { container } = render(<ThemeProvider><ChatView state={state} toolContext={defaultToolContext} /></ThemeProvider>);
    const card = container.querySelector('[data-testid="pending-prompt-card"]');
    expect(card).toBeNull();
  });

  it("renders pending prompt card with images", () => {
    const state = createInitialState();
    state.pendingPrompt = {
      text: "Check this",
      images: [{ data: "abc123", mimeType: "image/png" }],
    };
    const { container } = render(<ThemeProvider><ChatView state={state} toolContext={defaultToolContext} /></ThemeProvider>);
    const card = container.querySelector('[data-testid="pending-prompt-card"]');
    expect(card).not.toBeNull();
    const img = card!.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toContain("data:image/png;base64,abc123");
  });

  it("opens lightbox when clicking a user message image", () => {
    const state = createInitialState();
    state.messages.push({
      id: "img-msg",
      role: "user",
      content: "See this",
      timestamp: Date.now(),
      images: [{ data: "abc123", mimeType: "image/png" }],
    });
    const { container } = render(<ThemeProvider><ChatView state={state} toolContext={defaultToolContext} /></ThemeProvider>);
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.className).toContain("cursor-pointer");
    fireEvent.click(img!);
    const lightbox = document.body.querySelector("[data-testid='lightbox-backdrop']");
    expect(lightbox).not.toBeNull();
  });

  it("hides empty-state message when pendingPrompt is set", () => {
    const state = createInitialState();
    state.pendingPrompt = { text: "Hello" };
    const { container } = render(<ThemeProvider><ChatView state={state} toolContext={defaultToolContext} /></ThemeProvider>);
    expect(container.textContent).not.toContain("No messages yet");
  });

  describe("scroll lock", () => {
    let scrollToSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      scrollToSpy = vi.fn();
      Element.prototype.scrollTo = scrollToSpy as any;
    });

    /** Helper to set scroll geometry on the scroll container */
    function setScrollPosition(el: Element, scrollTop: number, scrollHeight: number, clientHeight: number) {
      Object.defineProperty(el, "scrollTop", { value: scrollTop, writable: true, configurable: true });
      Object.defineProperty(el, "scrollHeight", { value: scrollHeight, writable: true, configurable: true });
      Object.defineProperty(el, "clientHeight", { value: clientHeight, writable: true, configurable: true });
    }

    function getScrollContainer(container: HTMLElement): HTMLElement {
      return container.querySelector("[class*='overflow-y-auto']")!;
    }

    it("auto-scrolls when near bottom (default behavior)", async () => {
      const state = stateWithMessages([
        { id: "1", role: "user", content: "Hello" },
      ]);
      const { rerender } = render(<ThemeProvider><ChatView state={state} toolContext={defaultToolContext} /></ThemeProvider>);

      // isNearBottom defaults to true, so adding a message should trigger scrollTo
      scrollToSpy.mockClear();
      const state2 = stateWithMessages([
        { id: "1", role: "user", content: "Hello" },
        { id: "2", role: "assistant", content: "Hi" },
      ]);
      rerender(<ThemeProvider><ChatView state={state2} toolContext={defaultToolContext} /></ThemeProvider>);

      // scrollTo is called inside requestAnimationFrame — flush it
      await vi.waitFor(() => {
        expect(scrollToSpy).toHaveBeenCalled();
      });
    });

    it("does NOT auto-scroll when scrolled away from bottom", () => {
      const state = stateWithMessages([
        { id: "1", role: "user", content: "Hello" },
      ]);
      const { container, rerender } = render(<ThemeProvider><ChatView state={state} toolContext={defaultToolContext} /></ThemeProvider>);

      const scrollEl = getScrollContainer(container);
      // Simulate user scrolling up: far from bottom
      setScrollPosition(scrollEl, 0, 1000, 400);
      fireEvent.scroll(scrollEl);

      scrollToSpy.mockClear();
      const state2 = stateWithMessages([
        { id: "1", role: "user", content: "Hello" },
        { id: "2", role: "assistant", content: "Hi" },
      ]);
      rerender(<ThemeProvider><ChatView state={state2} toolContext={defaultToolContext} /></ThemeProvider>);

      expect(scrollToSpy).not.toHaveBeenCalled();
    });

    it("shows scroll-to-bottom button when not near bottom", () => {
      const state = stateWithMessages([
        { id: "1", role: "user", content: "Hello" },
      ]);
      const { container } = render(<ThemeProvider><ChatView state={state} toolContext={defaultToolContext} /></ThemeProvider>);

      const scrollEl = getScrollContainer(container);
      setScrollPosition(scrollEl, 0, 1000, 400);
      fireEvent.scroll(scrollEl);

      const btn = container.querySelector('[data-testid="scroll-to-bottom"]');
      expect(btn).not.toBeNull();
    });

    it("hides scroll-to-bottom button when near bottom", () => {
      const state = stateWithMessages([
        { id: "1", role: "user", content: "Hello" },
      ]);
      const { container } = render(<ThemeProvider><ChatView state={state} toolContext={defaultToolContext} /></ThemeProvider>);

      // Default state — near bottom
      const btn = container.querySelector('[data-testid="scroll-to-bottom"]');
      expect(btn).toBeNull();

      // Scroll up then back to bottom
      const scrollEl = getScrollContainer(container);
      setScrollPosition(scrollEl, 0, 1000, 400);
      fireEvent.scroll(scrollEl);
      expect(container.querySelector('[data-testid="scroll-to-bottom"]')).not.toBeNull();

      setScrollPosition(scrollEl, 970, 1000, 400);
      fireEvent.scroll(scrollEl);
      expect(container.querySelector('[data-testid="scroll-to-bottom"]')).toBeNull();
    });

    it("clicking scroll-to-bottom button calls scrollTo and hides button", () => {
      const state = stateWithMessages([
        { id: "1", role: "user", content: "Hello" },
      ]);
      const { container } = render(<ThemeProvider><ChatView state={state} toolContext={defaultToolContext} /></ThemeProvider>);

      const scrollEl = getScrollContainer(container);
      setScrollPosition(scrollEl, 0, 1000, 400);
      fireEvent.scroll(scrollEl);

      scrollToSpy.mockClear();
      const btn = container.querySelector('[data-testid="scroll-to-bottom"]')!;
      fireEvent.click(btn);

      expect(scrollToSpy).toHaveBeenCalledWith(expect.objectContaining({ behavior: "smooth" }));
      // Button should be hidden after click
      expect(container.querySelector('[data-testid="scroll-to-bottom"]')).toBeNull();
    });
  });

  describe("error banner", () => {
    it("renders error banner when lastError is set", () => {
      const state = createInitialState();
      state.lastError = { message: "Rate limit exceeded", timestamp: Date.now() };

      const { container } = render(
        <ThemeProvider>
          <ChatView state={state} toolContext={defaultToolContext} />
        </ThemeProvider>,
      );

      const banner = container.querySelector('[data-testid="error-banner"]');
      expect(banner).toBeTruthy();
      expect(banner!.textContent).toContain("Rate limit exceeded");
    });

    it("does not render error banner when lastError is undefined", () => {
      const state = createInitialState();

      const { container } = render(
        <ThemeProvider>
          <ChatView state={state} toolContext={defaultToolContext} />
        </ThemeProvider>,
      );

      expect(container.querySelector('[data-testid="error-banner"]')).toBeNull();
    });

    it("calls onDismissError when dismiss button clicked", () => {
      const state = createInitialState();
      state.lastError = { message: "Quota exceeded", timestamp: Date.now() };
      const onDismiss = vi.fn();

      const { container } = render(
        <ThemeProvider>
          <ChatView state={state} toolContext={defaultToolContext} onDismissError={onDismiss} />
        </ThemeProvider>,
      );

      const dismissBtn = container.querySelector('[data-testid="error-banner-dismiss"]');
      expect(dismissBtn).toBeTruthy();
      fireEvent.click(dismissBtn!);
      expect(onDismiss).toHaveBeenCalledOnce();
    });
  });

  // See change: render-skill-invocations-collapsibly.
  describe("skill-invocation routing", () => {
    it("routes user messages with skill metadata to SkillInvocationCard", () => {
      const state = createInitialState();
      const wrapped = `<skill name="openspec-explore" location="/x/SKILL.md">\nbody\n</skill>\n\nfollow up`;
      state.messages.push({
        id: "u-skill",
        role: "user",
        content: wrapped,
        timestamp: 1,
        skill: {
          name: "openspec-explore",
          location: "/x/SKILL.md",
          body: "body",
          args: "follow up",
          condensed: "/skill:openspec-explore follow up",
        },
      } as ChatMessage);
      state.messages.push({
        id: "u-plain",
        role: "user",
        content: "plain prompt",
        timestamp: 2,
      } as ChatMessage);
      const { container } = render(
        <ThemeProvider>
          <ChatView state={state} toolContext={defaultToolContext} />
        </ThemeProvider>,
      );
      // The skill card uses aria-expanded for its toggle button. The plain bubble does not.
      const expandToggles = container.querySelectorAll("button[aria-expanded]");
      expect(expandToggles.length).toBe(1);
      // The condensed slash form appears in the document
      expect(container.textContent).toContain("/skill:openspec-explore follow up");
      // The plain prompt also renders
      expect(container.textContent).toContain("plain prompt");
    });

    it("plain user messages without skill stamp render as the regular bubble", () => {
      const state = stateWithMessages([
        { id: "u", role: "user", content: "hello" },
      ]);
      const { container } = render(
        <ThemeProvider>
          <ChatView state={state} toolContext={defaultToolContext} />
        </ThemeProvider>,
      );
      // No card-style toggle button
      expect(container.querySelectorAll("button[aria-expanded]").length).toBe(0);
      // Standard MessageBubble copy buttons present
      expect(container.querySelector('button[title="Copy as Markdown"]')).not.toBeNull();
    });
  });

  describe("retry banner integration (provider-retry-state)", () => {
    it("does not render retry banner when retryState is undefined", () => {
      const state = createInitialState();
      const { container } = render(
        <ThemeProvider>
          <ChatView state={state} toolContext={defaultToolContext} />
        </ThemeProvider>,
      );
      expect(container.querySelector('[data-testid="retry-banner"]')).toBeNull();
    });

    it("renders retry banner when retryState is set with delayMs >= 500", () => {
      const state = {
        ...createInitialState(),
        retryState: { attempt: 1, maxAttempts: 3, delayMs: 2000, reason: "rate limit", startedAt: 0 },
      };
      const { container } = render(
        <ThemeProvider>
          <ChatView state={state} toolContext={defaultToolContext} />
        </ThemeProvider>,
      );
      expect(container.querySelector('[data-testid="retry-banner"]')).not.toBeNull();
    });

    it("renders retry banner with indeterminate state when delayMs is sentinel -1", () => {
      const state = {
        ...createInitialState(),
        retryState: { attempt: 1, maxAttempts: -1, delayMs: -1, reason: "x", startedAt: 0 },
      };
      const { container } = render(
        <ThemeProvider>
          <ChatView state={state} toolContext={defaultToolContext} />
        </ThemeProvider>,
      );
      expect(container.querySelector('[data-testid="retry-banner"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="retry-banner-indeterminate"]')).not.toBeNull();
    });

    it("retry banner and error banner can coexist (retry above error)", () => {
      const state = {
        ...createInitialState(),
        retryState: { attempt: 2, maxAttempts: 3, delayMs: 4000, reason: "x", startedAt: 0 },
        lastError: { message: "boom", timestamp: 0 },
      };
      const { container } = render(
        <ThemeProvider>
          <ChatView state={state} toolContext={defaultToolContext} />
        </ThemeProvider>,
      );
      const retry = container.querySelector('[data-testid="retry-banner"]');
      const error = container.querySelector('[data-testid="error-banner"]');
      expect(retry).not.toBeNull();
      expect(error).not.toBeNull();
      // Retry must appear before error in document order (compareDocumentPosition: 4 = following)
      expect(retry!.compareDocumentPosition(error!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });
});
