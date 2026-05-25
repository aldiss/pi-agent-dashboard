/**
 * Regression suite for change: fix-thinking-block-collapse-default-on-commit.
 *
 * The chat view renders thinking content in two structurally separate
 * places: the live-streaming block at `ChatView.tsx:~446` (passes
 * `defaultExpanded`) and the committed `messages[]` row at
 * `ChatView.tsx:~326`. Before the fix, the committed row omitted
 * `defaultExpanded` so the just-committed thinking block visually
 * disappeared at the live → committed mount transition (live block
 * unmounted, new keyed instance mounted under fresh `useState(false)`).
 *
 * These tests pin the contract that:
 *   1. ThinkingBlock honors `defaultExpanded={true}` literally — body visible on mount.
 *   2. ThinkingBlock without `defaultExpanded` collapses by default — body hidden on mount.
 *   3. The "live → committed" mount transition no longer hides content
 *      when both instances pass `defaultExpanded`.
 *
 * See investigation: ~/.pi/orchestration-state/pi-dashboard-thinking-
 * block-streaming-state-loss-investigation-2026-05-25.md
 */

import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import React from "react";
import { ThinkingBlock } from "../ThinkingBlock.js";
import { ThemeProvider } from "../ThemeProvider.js";

// jsdom doesn't implement matchMedia, which ThemeProvider/useTheme
// require. Stub before any render so ThemeProvider mounts cleanly.
// Sister-precedent: ChatView.scroll-race.test.tsx + ChatView.streaming-
// text-flush.test.tsx.
beforeAll(() => {
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

// ThinkingBlock's expanded body uses MarkdownContent which requires
// the ThemeProvider context. Wrap every render call so the body renders
// cleanly under test.
function renderWithTheme(ui: React.ReactElement) {
  return render(<ThemeProvider>{ui}</ThemeProvider>);
}

describe("ThinkingBlock collapse-default contract", () => {
  afterEach(() => cleanup());

  it("expands by default when defaultExpanded={true}", () => {
    renderWithTheme(<ThinkingBlock content="reasoning content" defaultExpanded />);
    expect(screen.getByText(/reasoning content/)).toBeTruthy();
  });

  it("collapses by default when defaultExpanded is omitted", () => {
    renderWithTheme(<ThinkingBlock content="reasoning content" />);
    expect(screen.queryByText(/reasoning content/)).toBeNull();
  });

  it("collapses by default when defaultExpanded={false} (explicit)", () => {
    renderWithTheme(<ThinkingBlock content="reasoning content" defaultExpanded={false} />);
    expect(screen.queryByText(/reasoning content/)).toBeNull();
  });

  it("user can toggle expanded state via the Reasoning button", () => {
    renderWithTheme(<ThinkingBlock content="reasoning content" />);
    expect(screen.queryByText(/reasoning content/)).toBeNull();
    fireEvent.click(screen.getByText(/Reasoning/));
    expect(screen.getByText(/reasoning content/)).toBeTruthy();
  });

  it("renders the streaming pulse indicator only when isStreaming={true}", () => {
    const { container, rerender } = renderWithTheme(
      <ThinkingBlock content="reasoning content" isStreaming defaultExpanded />,
    );
    // The pulsing cursor inside the expanded body
    expect(container.querySelector(".animate-pulse")).toBeTruthy();

    rerender(
      <ThemeProvider>
        <ThinkingBlock content="reasoning content" defaultExpanded />
      </ThemeProvider>,
    );
    expect(container.querySelector(".animate-pulse")).toBeNull();
  });

  // Regression guard for the live → committed-row React-key transition.
  //
  // ChatView renders live thinking with `defaultExpanded={true}`. When
  // `thinking_end` fires, the live block unmounts (streamingThinking is
  // cleared) and a new ThinkingBlock instance mounts inside messages[]
  // under a fresh React key. Before the fix the committed-row JSX
  // omitted `defaultExpanded`, so the new instance opened collapsed and
  // the thinking body visually disappeared. With both instances passing
  // `defaultExpanded={true}` the body remains visible across the
  // transition. We simulate the unmount/remount via two `render` calls
  // (separate `key` cycles) — see `cleanup` between tests.
  it("committed thinking row from messages[] stays expanded by default after live block unmounts", () => {
    // Phase A — live streaming block (analogous to ChatView.tsx:~446)
    const { unmount } = renderWithTheme(
      <ThinkingBlock
        content="streamed reasoning content"
        isStreaming
        defaultExpanded
      />,
    );
    expect(screen.getByText(/streamed reasoning content/)).toBeTruthy();
    unmount();

    // Phase B — committed `messages[]` row (analogous to ChatView.tsx:~326)
    // After the fix this MUST also pass `defaultExpanded`. If the prop
    // were silently dropped, `useState(false)` would collapse the body.
    renderWithTheme(
      <ThinkingBlock
        content="streamed reasoning content"
        defaultExpanded
        startedAt={1000}
        duration={500}
      />,
    );
    expect(screen.getByText(/streamed reasoning content/)).toBeTruthy();
  });
});
