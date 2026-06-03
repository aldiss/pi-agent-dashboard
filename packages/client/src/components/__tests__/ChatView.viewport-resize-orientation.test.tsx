import { describe, it, expect, beforeAll, vi } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import React from "react";
import { ChatView } from "../ChatView.js";
import { ThemeProvider } from "../ThemeProvider.js";
import { createInitialState } from "../../lib/event-reducer.js";
import type { ToolContext } from "../tool-renderers/index.js";

const defaultToolContext: ToolContext = { editors: [] };

beforeAll(() => {
  // jsdom doesn't implement scrollTo / matchMedia / visualViewport
  Element.prototype.scrollTo = function (this: Element, ..._args: unknown[]) {
    // record the call by writing scrollTop = scrollHeight (the "scrolled to bottom" signature)
    // since most call sites use scrollTo(0, scrollHeight)
    const arg = _args[0];
    if (typeof arg === "number") {
      Object.defineProperty(this, "scrollTop", {
        value: _args[1] ?? 0,
        writable: true,
        configurable: true,
      });
    } else if (arg && typeof arg === "object" && "top" in arg) {
      Object.defineProperty(this, "scrollTop", {
        value: (arg as { top: number }).top,
        writable: true,
        configurable: true,
      });
    }
  };
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

function setScrollPosition(el: Element, scrollTop: number, scrollHeight: number, clientHeight: number) {
  Object.defineProperty(el, "scrollTop", { value: scrollTop, writable: true, configurable: true });
  Object.defineProperty(el, "scrollHeight", { value: scrollHeight, writable: true, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: clientHeight, writable: true, configurable: true });
}

function getScrollContainer(container: HTMLElement): HTMLElement {
  return container.querySelector("[class*='overflow-y-auto']")!;
}

function stateWith(n: number) {
  const s = createInitialState();
  for (let i = 0; i < n; i++) {
    s.messages.push({ id: String(i), role: "user", content: `m${i}`, timestamp: Date.now() });
  }
  return s;
}

async function flushRaf() {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

async function advanceTime(ms: number) {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  });
}

describe("ChatView viewport-resize / orientation-flip re-anchor (fix-mobile-chat-scroll-orientation-flip)", () => {
  it("re-scrolls to bottom on orientationchange when user was near bottom pre-rotation", async () => {
    const { container, rerender } = render(
      <ThemeProvider>
        <ChatView state={stateWith(50)} toolContext={defaultToolContext} sessionId="s1" />
      </ThemeProvider>,
    );
    await flushRaf();

    const scrollEl = getScrollContainer(container);

    // User at bottom: scrollTop = scrollHeight - clientHeight (geometry of "at bottom")
    setScrollPosition(scrollEl, 4600, 5000, 400);
    fireEvent.scroll(scrollEl);
    // No scroll-to-bottom button should be visible
    expect(container.querySelector('[data-testid="scroll-to-bottom"]')).toBeNull();

    // Simulate iPhone rotation: clientHeight shrinks (landscape), scrollHeight reflows
    // (text wraps differently). scrollTop is preserved by browser → user lands mid-chat
    // because scrollTop (4600) is now well below the new scrollHeight - clientHeight
    // (new geometry: clientHeight=200, scrollHeight=6000 → bottom at 5800).
    setScrollPosition(scrollEl, 4600, 6000, 200);
    fireEvent(window, new Event("orientationchange"));

    // Settle window (350 ms in implementation). Advance time past it.
    await advanceTime(400);

    // After settle, scrollTop should be re-anchored to scrollHeight (= 6000)
    expect(scrollEl.scrollTop).toBe(6000);
    // Scroll-to-bottom button should NOT be visible (we re-stuck to bottom)
    expect(container.querySelector('[data-testid="scroll-to-bottom"]')).toBeNull();

    // Silence unused rerender warning
    rerender(
      <ThemeProvider>
        <ChatView state={stateWith(50)} toolContext={defaultToolContext} sessionId="s1" />
      </ThemeProvider>,
    );
  });

  it("preserves position on orientationchange when user had scrolled UP pre-rotation", async () => {
    const { container } = render(
      <ThemeProvider>
        <ChatView state={stateWith(50)} toolContext={defaultToolContext} sessionId="s2" />
      </ThemeProvider>,
    );
    await flushRaf();

    const scrollEl = getScrollContainer(container);

    // User scrolled UP: scrollTop = 100, far from bottom (scrollHeight - clientHeight = 4600)
    setScrollPosition(scrollEl, 100, 5000, 400);
    fireEvent.scroll(scrollEl);
    // Wait past programmaticScroll suppression (150 ms)
    await advanceTime(200);
    setScrollPosition(scrollEl, 100, 5000, 400);
    fireEvent.scroll(scrollEl);
    expect(container.querySelector('[data-testid="scroll-to-bottom"]')).not.toBeNull();

    // Rotation: layout changes but scrollTop preserved by browser
    setScrollPosition(scrollEl, 100, 6000, 200);
    fireEvent(window, new Event("orientationchange"));
    await advanceTime(400);

    // We must NOT have snapped to bottom — operator was reading mid-chat
    expect(scrollEl.scrollTop).toBe(100);
  });

  it("ignores racing onScroll events during the viewport-resize animation envelope", async () => {
    const { container } = render(
      <ThemeProvider>
        <ChatView state={stateWith(50)} toolContext={defaultToolContext} sessionId="s3" />
      </ThemeProvider>,
    );
    await flushRaf();

    const scrollEl = getScrollContainer(container);
    setScrollPosition(scrollEl, 4600, 5000, 400);
    fireEvent.scroll(scrollEl);
    expect(container.querySelector('[data-testid="scroll-to-bottom"]')).toBeNull();

    // Start of rotation — fire orientationchange
    fireEvent(window, new Event("orientationchange"));

    // DURING the rotation animation, a racing onScroll fires with geometry that
    // would normally indicate "user scrolled up" (scrollHeight grew but scrollTop
    // stale). Without the viewportResizing gate this would flip isNearBottom to
    // false and defeat the re-stick.
    setScrollPosition(scrollEl, 4600, 6000, 200);
    fireEvent.scroll(scrollEl);

    // Settle and verify we still re-stuck to bottom
    await advanceTime(400);
    expect(scrollEl.scrollTop).toBe(6000);
    expect(container.querySelector('[data-testid="scroll-to-bottom"]')).toBeNull();
  });

  it("debounces multiple visualViewport.resize events into a single re-scroll", async () => {
    const { container } = render(
      <ThemeProvider>
        <ChatView state={stateWith(50)} toolContext={defaultToolContext} sessionId="s4" />
      </ThemeProvider>,
    );
    await flushRaf();

    const scrollEl = getScrollContainer(container);
    setScrollPosition(scrollEl, 4600, 5000, 400);
    fireEvent.scroll(scrollEl);

    // Stub visualViewport so we can fire its resize event
    const target = new EventTarget();
    (window as any).visualViewport = target;

    // Mount a fresh ChatView so it picks up the visualViewport
    const { container: c2 } = render(
      <ThemeProvider>
        <ChatView state={stateWith(50)} toolContext={defaultToolContext} sessionId="s4b" />
      </ThemeProvider>,
    );
    await flushRaf();
    const scrollEl2 = getScrollContainer(c2);
    setScrollPosition(scrollEl2, 4600, 5000, 400);
    fireEvent.scroll(scrollEl2);

    // Fire a burst of resize events (rotation animation simulation)
    for (let i = 0; i < 5; i++) {
      target.dispatchEvent(new Event("resize"));
      await advanceTime(50); // 50ms between events, total 250ms (within debounce)
    }
    // Final geometry post-rotation
    setScrollPosition(scrollEl2, 4600, 6000, 200);
    await advanceTime(400); // settle window
    expect(scrollEl2.scrollTop).toBe(6000);

    // Cleanup
    delete (window as any).visualViewport;
  });
});
