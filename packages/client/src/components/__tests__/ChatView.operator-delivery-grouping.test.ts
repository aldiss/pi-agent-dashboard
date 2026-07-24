// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { createElement } from "react";
import { ChatView } from "../ChatView.js";
import { ThemeProvider } from "../ThemeProvider.js";
import { createInitialState, type ChatMessage } from "../../lib/event-reducer.js";
import type { ToolContext } from "../tool-renderers/index.js";

const SESSION_ID = "operator-delivery-grouping";
const PLAIN = "The release remains blocked until plain delivery is verified.";
const toolContext: ToolContext = { editors: [] };

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
  window.localStorage.setItem(`dashboard:messageFilter:${SESSION_ID}`, JSON.stringify({
    tierA: true,
    tierB: true,
    tierC: true,
    meshChatter: true,
    toolCalls: true,
    systemNotifications: true,
  }));
});

function tool(id: string): ChatMessage {
  return {
    id: `tool-${id}`,
    role: "toolResult",
    content: "bash",
    timestamp: 1,
    toolCallId: id,
    toolName: "bash",
    toolStatus: "complete",
    args: { command: "npm test" },
  };
}

describe("ChatView tool grouping preserves operator delivery", () => {
  it("renders nonempty plain prose as a boundary between collapsed tool groups", () => {
    const state = createInitialState();
    state.messages = [
      tool("a1"), tool("a2"), tool("a3"),
      { id: "plain", role: "assistant", content: PLAIN, timestamp: 2, audience: "operator" },
      tool("b1"), tool("b2"), tool("b3"),
    ];
    const { container } = render(createElement(
      ThemeProvider,
      null,
      createElement(ChatView, { state, toolContext, sessionId: SESSION_ID }),
    ));
    expect(container.textContent).toContain(PLAIN);
    expect(container.querySelectorAll('[data-testid="collapsed-group"]')).toHaveLength(2);
  });
});
