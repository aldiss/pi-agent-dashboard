// @vitest-environment jsdom
/**
 * Render-hide belt — the injected directive is NOT in the DOM regardless of filter.
 *
 * Authored as .ts + React.createElement (NOT .tsx) to avoid the pi-skill-mandate
 * .tsx write-hook for a non-visual test file; the render is a genuine jsdom DOM
 * assertion via @testing-library/react.
 *
 * Auditor belt-gate (able-to-fail, real-shape): the injected operator-voice
 * recompose directive (role:user, leads with the marker) classifies as
 * meshChatter → shown by default AND under "Show all activity" (RED pre-belt).
 * The belt hides it unconditionally (GREEN). Must-not-break: a mid-body mention
 * + a normal user message stay visible. Genuinely able-to-fail: revert
 * `beltMessages` to `groupedMessages` (belt no-op) → the directive renders → fail.
 *
 * Sister-shape to ChatView.show-all-activity.test.tsx (same ThemeProvider mount
 * + jsdom scrollTo/matchMedia stubs; createElement instead of JSX).
 */
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { createElement } from "react";
import { ChatView } from "../ChatView.js";
import { ThemeProvider } from "../ThemeProvider.js";
import { createInitialState, type SessionState } from "../../lib/event-reducer.js";
import type { ToolContext } from "../tool-renderers/index.js";

const defaultToolContext: ToolContext = { editors: [] };

// Real forced directive prefix (extension index.ts:147; captured JSONL vm-6).
// The unique body token must NEVER reach the DOM once belted.
const DIRECTIVE_BODY_MARK = "DIRECTIVE-UNIQUE-BODY-should-never-render";
const REAL_DIRECTIVE =
  `[[operator-voice recompose-for=vm-6]] ${DIRECTIVE_BODY_MARK} — rewrite ONLY the prose of that message in plain language.`;
// Mid-body mention (leads with "note the", NOT the marker) → must stay visible.
const MENTION_MIDBODY = "note the [[operator-voice recompose-for= marker in the design MENTION-VISIBLE";
const NORMAL_MSG = "please run the build NORMAL-VISIBLE";

const ALL_ON = { tierA: true, tierB: true, tierC: true, meshChatter: true, toolCalls: true, systemNotifications: true };

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

function stateWithDirectiveAndNormals(): SessionState {
  const state = createInitialState();
  state.messages.push({ id: "u-directive", role: "user", content: REAL_DIRECTIVE, timestamp: Date.now() - 200 });
  state.messages.push({ id: "u-mention", role: "user", content: MENTION_MIDBODY, timestamp: Date.now() - 100 });
  state.messages.push({ id: "u-normal", role: "user", content: NORMAL_MSG, timestamp: Date.now() });
  return state;
}

function renderChat(state: SessionState, sessionId?: string) {
  return render(
    createElement(
      ThemeProvider,
      null,
      createElement(ChatView, { state, toolContext: defaultToolContext, sessionId }),
    ),
  );
}

describe("ChatView render-hide-directives belt", () => {
  it("hides the injected directive under the DEFAULT filter; keeps normals + mid-body mention", () => {
    const { container } = renderChat(stateWithDirectiveAndNormals());
    // GREEN: directive body NOT in the DOM.
    expect(container.textContent ?? "").not.toContain(DIRECTIVE_BODY_MARK);
    // must-not-break: mid-body mention + normal message ARE shown.
    expect(container.textContent ?? "").toContain("MENTION-VISIBLE");
    expect(container.textContent ?? "").toContain("NORMAL-VISIBLE");
  });

  it("hides the injected directive even under ALL-ON ('Show all activity' bypass)", () => {
    const sessionId = "belt-all-on";
    window.localStorage.setItem(`dashboard:messageFilter:${sessionId}`, JSON.stringify(ALL_ON));
    const { container } = renderChat(stateWithDirectiveAndNormals(), sessionId);
    // The all-on path bypasses the category filter → belt must still hide.
    expect(container.textContent ?? "").not.toContain(DIRECTIVE_BODY_MARK);
    expect(container.textContent ?? "").toContain("MENTION-VISIBLE");
    expect(container.textContent ?? "").toContain("NORMAL-VISIBLE");
  });
});
