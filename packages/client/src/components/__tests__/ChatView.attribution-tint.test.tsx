/**
 * ChatView L3 bubble-tint tests (multi-operator, Surface A — Option B).
 *
 * Two invariants:
 *   - A user turn that CARRIES an author gets the role-anchored L3 tint applied
 *     to the bubble (operator → amber, guest → violet) — and DROPS the
 *     `editorial-userbubble` + blue classes so the skin's `!important` rule can't
 *     override the inline tint.
 *   - A user turn with NO author is BYTE-UNCHANGED: the today blue bubble
 *     (`editorial-userbubble bg-blue-500/10 … border-l-blue-400`), no tint.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import React from "react";

// Deterministic viewer identity — avoids the real /auth/status fetch in jsdom.
vi.mock("../../hooks/useAuthStatus.js", () => ({
  useAuthStatus: () => ({
    loading: false,
    authStatus: { authenticated: true, authEnabled: true, user: { name: "Op One", email: "op1@example.com", provider: "github" } },
  }),
  redirectToLogin: () => {},
}));

import { ChatView } from "../ChatView.js";
import { ThemeProvider } from "../ThemeProvider.js";
import { createInitialState, type ChatMessage } from "../../lib/event-reducer.js";
import type { ToolContext } from "../tool-renderers/index.js";
import type { MessageAuthor } from "@blackbelt-technology/pi-dashboard-shared/types.js";

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

afterEach(() => cleanup());

function stateWithUser(content: string, author?: MessageAuthor) {
  const state = createInitialState();
  state.messages.push({
    id: "u1",
    role: "user",
    content,
    timestamp: Date.now(),
    ...(author ? { author } : {}),
  } as ChatMessage);
  return state;
}

function userBubble(container: HTMLElement): HTMLElement | null {
  // The bubble is the div wrapping MessageBubble — carries rounded-xl + shadow-md
  // and either the blue classes (no-author) or the tint style (author).
  return container.querySelector("[data-attribution-tint], .bg-blue-500\\/10") as HTMLElement | null;
}

describe("ChatView — no-author turn is byte-unchanged (blue bubble)", () => {
  it("keeps editorial-userbubble + blue classes, no tint attribute", () => {
    const state = stateWithUser("hello, no author");
    const { container } = render(
      <ThemeProvider><ChatView state={state} toolContext={defaultToolContext} /></ThemeProvider>,
    );
    const bubble = container.querySelector(".bg-blue-500\\/10") as HTMLElement;
    expect(bubble).not.toBeNull();
    expect(bubble.className).toContain("editorial-userbubble");
    expect(bubble.className).toContain("border-l-blue-400");
    expect(bubble.className).toContain("rounded-xl");
    expect(bubble.className).toContain("shadow-md");
    // No tint applied.
    expect(bubble.getAttribute("data-attribution-tint")).toBeNull();
    expect(bubble.style.backgroundColor).toBe("");
  });

  it("renders no AttributionChip when the turn has no author", () => {
    const state = stateWithUser("hello");
    const { container } = render(
      <ThemeProvider><ChatView state={state} toolContext={defaultToolContext} /></ThemeProvider>,
    );
    expect(container.querySelector("[data-attribution-sub]")).toBeNull();
  });
});

describe("ChatView — authored turn gets the L3 role tint", () => {
  it("operator author → AMBER inline tint, drops editorial-userbubble + blue classes", () => {
    const state = stateWithUser("hi from operator", { sub: "op1@example.com", display: "Op One", isOperator: true });
    const { container } = render(
      <ThemeProvider><ChatView state={state} toolContext={defaultToolContext} /></ThemeProvider>,
    );
    const bubble = container.querySelector('[data-attribution-tint="operator"]') as HTMLElement;
    expect(bubble).not.toBeNull();
    // Amber rgba applied inline (jsdom normalizes 0.20 → 0.2).
    expect(bubble.style.backgroundColor).toBe("rgba(245, 158, 11, 0.2)");
    expect(bubble.style.borderColor).toBe("rgba(245, 158, 11, 0.4)");
    // The !important-carrying skin class + blue classes are GONE so inline wins.
    expect(bubble.className).not.toContain("editorial-userbubble");
    expect(bubble.className).not.toContain("bg-blue-500/10");
    expect(bubble.className).not.toContain("border-l-blue-400");
    // Structure preserved.
    expect(bubble.className).toContain("rounded-xl");
    expect(bubble.className).toContain("shadow-md");
  });

  it("guest author → VIOLET inline tint", () => {
    const state = stateWithUser("hi from guest", { sub: "guest@example.com", display: "Guest", isOperator: false });
    const { container } = render(
      <ThemeProvider><ChatView state={state} toolContext={defaultToolContext} /></ThemeProvider>,
    );
    const bubble = container.querySelector('[data-attribution-tint="guest"]') as HTMLElement;
    expect(bubble).not.toBeNull();
    expect(bubble.style.backgroundColor).toBe("rgba(139, 92, 246, 0.2)");
    expect(bubble.style.borderColor).toBe("rgba(139, 92, 246, 0.4)");
  });

  it("operator and guest bubbles are visually DISTINCT (amber vs violet)", () => {
    const opState = stateWithUser("op", { sub: "a", display: "A", isOperator: true });
    const guestState = stateWithUser("guest", { sub: "b", display: "B", isOperator: false });
    const { container: opC } = render(
      <ThemeProvider><ChatView state={opState} toolContext={defaultToolContext} /></ThemeProvider>,
    );
    const { container: guestC } = render(
      <ThemeProvider><ChatView state={guestState} toolContext={defaultToolContext} /></ThemeProvider>,
    );
    const opBubble = opC.querySelector('[data-attribution-tint="operator"]') as HTMLElement;
    const guestBubble = guestC.querySelector('[data-attribution-tint="guest"]') as HTMLElement;
    expect(opBubble.style.backgroundColor).not.toBe(guestBubble.style.backgroundColor);
  });

  it("renders the AttributionChip with 'You' when the authored turn is the viewer's own", () => {
    // Mocked viewer is op1@example.com → their own turn shows "You".
    const state = stateWithUser("mine", { sub: "op1@example.com", display: "Op One", isOperator: true });
    const { container, getByText } = render(
      <ThemeProvider><ChatView state={state} toolContext={defaultToolContext} /></ThemeProvider>,
    );
    expect(container.querySelector("[data-attribution-sub]")).not.toBeNull();
    expect(getByText("You")).toBeTruthy();
  });
});
