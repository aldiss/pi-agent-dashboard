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

afterEach(() => { cleanup(); localStorage.clear(); });

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

describe("ChatView — authored turn gets the L2 accent rail (sides-only)", () => {
  it("operator author → AMBER right-rail (inset box-shadow), KEEPS default bubble, no full-fill", () => {
    const state = stateWithUser("hi from operator", { sub: "op1@example.com", display: "Op One", isOperator: true });
    const { container } = render(
      <ThemeProvider><ChatView state={state} toolContext={defaultToolContext} /></ThemeProvider>,
    );
    const bubble = container.querySelector('[data-attribution-tint="operator"]') as HTMLElement;
    expect(bubble).not.toBeNull();
    // Dark-theme amber rail via inset box-shadow on the right edge; NO full-fill bg.
    expect(bubble.style.boxShadow).toMatch(/inset -3px 0 0 0 rgb\(245,\s*158,\s*11\)/);
    expect(bubble.style.backgroundColor).toBe(""); // default cream bg kept (no full-fill)
    // The default editorial bubble is KEPT (rail composes over it, not dropped).
    expect(bubble.className).toContain("editorial-userbubble");
    expect(bubble.className).toContain("rounded-xl");
  });

  it("guest author → VIOLET right-rail", () => {
    const state = stateWithUser("hi from guest", { sub: "guest@example.com", display: "Guest", isOperator: false });
    const { container } = render(
      <ThemeProvider><ChatView state={state} toolContext={defaultToolContext} /></ThemeProvider>,
    );
    const bubble = container.querySelector('[data-attribution-tint="guest"]') as HTMLElement;
    expect(bubble).not.toBeNull();
    expect(bubble.style.boxShadow).toMatch(/inset -3px 0 0 0 rgb\(139,\s*92,\s*246\)/);
    expect(bubble.style.backgroundColor).toBe("");
  });

  it("operator and guest rails are visually DISTINCT (amber vs violet)", () => {
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
    expect(opBubble.style.boxShadow).not.toBe(guestBubble.style.boxShadow);
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

describe("ChatView — LIGHT theme accent rail (theme-aware, readable on cream)", () => {
  function renderLight(state: ReturnType<typeof stateWithUser>) {
    // Force the light theme (STORAGE_KEY "dashboard:theme") so ChatView passes
    // resolved="light" into bubbleRailFor; the top-level afterEach clears it.
    localStorage.setItem("dashboard:theme", "light");
    return render(
      <ThemeProvider><ChatView state={state} toolContext={defaultToolContext} /></ThemeProvider>,
    );
  }

  it("operator (light) → dark-amber rail (WCAG border hue), default bg kept", () => {
    const { container } = renderLight(
      stateWithUser("hi", { sub: "op1@example.com", display: "Op One", isOperator: true }),
    );
    const bubble = container.querySelector('[data-attribution-tint="operator"]') as HTMLElement;
    expect(bubble).not.toBeNull();
    expect(bubble.style.boxShadow).toMatch(/inset -3px 0 0 0 rgb\(180,\s*83,\s*9\)/);
    expect(bubble.style.backgroundColor).toBe(""); // no full-fill; default cream bg
  });

  it("guest (light) → dark-violet rail", () => {
    const { container } = renderLight(
      stateWithUser("hi", { sub: "guest@example.com", display: "Guest", isOperator: false }),
    );
    const bubble = container.querySelector('[data-attribution-tint="guest"]') as HTMLElement;
    expect(bubble).not.toBeNull();
    expect(bubble.style.boxShadow).toMatch(/inset -3px 0 0 0 rgb\(109,\s*40,\s*217\)/);
  });
});
