// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { createElement } from "react";
import type { DashboardEvent } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import { ChatView } from "../ChatView.js";
import { ThemeProvider } from "../ThemeProvider.js";
import { createInitialState, reduceEvent } from "../../lib/event-reducer.js";
import { sha256Hex } from "../../lib/operator-delivery.js";
import type { ToolContext } from "../tool-renderers/index.js";

const SOURCE = "Per dl-11743 §2A, CODENAME-47 failed. Decision: do not deploy.";
const PLAIN = "The final review failed. Do not deploy.";
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
});

function renderEvents(events: DashboardEvent[]) {
  const state = events.reduce(reduceEvent, createInitialState());
  return render(createElement(ThemeProvider, null, createElement(ChatView, { state, toolContext })));
}

const start = { eventType: "message_start", timestamp: 1, data: { message: { role: "assistant", content: [] } } } as DashboardEvent;
const update = {
  eventType: "message_update",
  timestamp: 2,
  data: {
    message: { role: "assistant", audience: "agent", content: SOURCE },
    assistantMessageEvent: { type: "text_delta", delta: SOURCE },
  },
} as DashboardEvent;
const tool = {
  eventType: "tool_execution_start",
  timestamp: 3,
  data: { toolCallId: "tool-1", toolName: "bash", args: { command: "npm test" } },
} as DashboardEvent;

describe("ChatView pre-final assistant hold", () => {
  it("never renders source prose while its tool is running", () => {
    const { container } = renderEvents([start, update, tool]);
    expect(container.textContent).not.toContain("dl-11743");
    expect(container.textContent).not.toContain("CODENAME-47");
  });

  it("renders only verified plain prose after finalization", () => {
    const end = {
      eventType: "message_end",
      timestamp: 4,
      data: {
        message: {
          role: "assistant",
          audience: "operator",
          content: [
            { type: "text", text: SOURCE },
            { type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "npm test" } },
          ],
          operatorDelivery: {
            version: 1,
            sourceSha256: sha256Hex(SOURCE),
            status: "ready",
            text: PLAIN,
            checks: { plain: true, anchorsPreserved: true },
          },
        },
      },
    } as DashboardEvent;
    const { container } = renderEvents([start, update, tool, end]);
    expect(container.textContent).toContain(PLAIN);
    expect(container.textContent).not.toContain("dl-11743");
  });
});
