/**
 * door-3 operator-voice pre-render hold — RENDER-BOUNDARY test (operator-visible).
 *
 * Pure reducer-state tests prove the state machine, but NOT that the hold is
 * operator-VISIBLE — the false-green class that failed the sister arc's E2E
 * (internal rep asserted, DOM never driven). This drives the real ChatView DOM:
 *
 *   - held buffer open (heldOperatorText populated, streamingText="") → the held
 *     text is NOT in the rendered DOM (no live streaming bubble). THE hold, proven
 *     at the render boundary.
 *   - a released/committed clean message IS in the rendered DOM.
 *
 * Plain-text-only states (no tool cards / ToolCallStep) dodge the pre-existing
 * jsdom-canvas trap that fails the other ChatView suites. Authored with
 * React.createElement in a .ts file (no JSX). See change: operator-voice-buffer-hold.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { render } from "@testing-library/react";
import { createElement } from "react";
import { ChatView } from "../ChatView.js";
import { ThemeProvider } from "../ThemeProvider.js";
import { createInitialState, type SessionState } from "../../lib/event-reducer.js";
import type { ToolContext } from "../tool-renderers/index.js";

const defaultToolContext: ToolContext = { editors: [] };

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

function renderChat(state: SessionState) {
  return render(
    createElement(ThemeProvider, null, createElement(ChatView, { state, toolContext: defaultToolContext })),
  );
}

describe("door-3 operator hold — render boundary (operator-VISIBLE)", () => {
  it("held operator buffer open → held text is NOT in the DOM (no live bubble)", () => {
    const state: SessionState = {
      ...createInitialState(),
      audience: "operator",
      heldOperatorText: "UNVERIFIED JARGON leverage synergy",
      heldBufferLastActivityAt: 123,
      streamingText: "", // the hold invariant: nothing routed to the live bubble
    };
    const { queryByText } = renderChat(state);
    // The operator NEVER sees the held (unverified) text while it is buffered.
    expect(queryByText(/UNVERIFIED JARGON leverage synergy/)).toBeNull();
  });

  it("released clean operator message IS in the rendered DOM", () => {
    const state: SessionState = {
      ...createInitialState(),
      audience: "operator",
      streamingText: "",
      messages: [{ id: "m0", role: "assistant", content: "plain released reply", timestamp: 1 }],
    };
    const { getByText } = renderChat(state);
    expect(getByText("plain released reply")).toBeTruthy();
  });

  it("Contract-D neutral placeholder renders; the held jargon never does", () => {
    // Post-timeout state: buffer released to the neutral placeholder, held dropped.
    const state: SessionState = {
      ...createInitialState(),
      audience: "operator",
      streamingText: "",
      heldOperatorText: "",
      messages: [{ id: "m0", role: "assistant", content: "\u2026", timestamp: 1 }],
    };
    const { queryByText, getByText } = renderChat(state);
    expect(getByText("\u2026")).toBeTruthy();
    expect(queryByText(/jargon/i)).toBeNull();
  });
});
