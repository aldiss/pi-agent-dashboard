// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import type { DashboardEvent } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import { ChatView } from "../ChatView.js";
import { ThemeProvider } from "../ThemeProvider.js";
import { createInitialState, reduceEvent, releaseAssistantBufferAsFallback, type SessionState } from "../../lib/event-reducer.js";
import { OPERATOR_DELIVERY_FALLBACK, sha256Hex } from "../../lib/operator-delivery.js";
import type { ToolContext } from "../tool-renderers/index.js";

const SOURCE = "Per dl-11743 §2A, Pete t30 BLOCK kept CODENAME-47 on hold. Correlation 550e8400-e29b-41d4-a716-446655440000; source 65ab66f0123456789abcdef. Decision: do not deploy until plain delivery passes review.";
const PLAIN = "The final review blocked this release because plain-language delivery was not reliable. The decision is to keep it undeployed until that delivery is verified.";
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

afterEach(cleanup);

function renderChat(state: SessionState, sessionId?: string) {
  return render(createElement(
    ThemeProvider,
    null,
    createElement(ChatView, { state, toolContext: defaultToolContext, sessionId }),
  ));
}

function reduceToEnd(operatorDelivery: unknown): SessionState {
  const events: DashboardEvent[] = [
    { eventType: "message_start", timestamp: 1, data: { message: { role: "assistant", content: [] } } } as DashboardEvent,
    { eventType: "message_update", timestamp: 2, data: { message: { role: "assistant", content: [{ type: "text", text: SOURCE }] } } } as DashboardEvent,
    {
      eventType: "message_end",
      timestamp: 3,
      data: {
        message: { role: "assistant", audience: "operator", content: [{ type: "text", text: SOURCE }], operatorDelivery },
        entryId: "entry-1",
        nonce: "nonce-1",
      },
    } as DashboardEvent,
  ];
  return events.reduce(reduceEvent, { ...createInitialState(), audience: "operator" });
}

describe("ChatView operator delivery boundary", () => {
  it("does not render a source partial before finalization, even with synthetic agent stamps", () => {
    let state: SessionState = { ...createInitialState(), audience: "agent" };
    state = reduceEvent(state, {
      eventType: "message_start",
      timestamp: 1,
      data: { message: { role: "assistant", audience: "agent", content: [] } },
    } as DashboardEvent);
    state = reduceEvent(state, {
      eventType: "message_update",
      timestamp: 2,
      data: {
        message: { role: "assistant", audience: "agent", content: [{ type: "text", text: SOURCE }] },
        assistantMessageEvent: { type: "text_delta", delta: SOURCE },
      },
    } as DashboardEvent);
    const { container } = renderChat(state);
    expect(container.textContent).not.toContain("dl-11743");
    expect(container.textContent).not.toContain("CODENAME-47");
  });

  it("does not render unproven thinking text", () => {
    let state: SessionState = { ...createInitialState(), audience: "agent" };
    const events: DashboardEvent[] = [
      { eventType: "message_start", timestamp: 1, data: { message: { role: "assistant", content: [] } } } as DashboardEvent,
      { eventType: "message_update", timestamp: 2, data: { message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "thinking_start" } } } as DashboardEvent,
      { eventType: "message_update", timestamp: 3, data: { message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "thinking_delta", delta: "dl-11743 §2A CODENAME-47" } } } as DashboardEvent,
    ];
    state = events.reduce(reduceEvent, state);
    const { container } = renderChat(state);
    expect(container.textContent).not.toContain("dl-11743");
    expect(container.textContent).not.toContain("CODENAME-47");
  });

  it("renders the verified plain facts and decision, with no source jargon in the DOM", () => {
    const state = reduceToEnd({
      version: 1,
      sourceSha256: "7e123305de49c74d895b7df8c2836c42cd22537976533fbf8220d31f99ae4847",
      status: "ready",
      text: PLAIN,
      checks: { plain: true, anchorsPreserved: true },
    });
    const { container } = renderChat(state);
    expect(container.textContent).toContain("The final review blocked this release");
    expect(container.textContent).toContain("keep it undeployed");
    expect(container.textContent).not.toContain("dl-11743");
    expect(container.textContent).not.toContain("§2A");
    expect(container.textContent).not.toContain("550e8400-e29b-41d4-a716-446655440000");
    expect(container.textContent).not.toContain("65ab66f0123456789abcdef");
    expect(container.textContent).not.toContain("CODENAME-47");
  });

  it("renders the exact honest fallback for a failed delivery, never source text or ellipsis", () => {
    const state = reduceToEnd({
      version: 1,
      sourceSha256: "7e123305de49c74d895b7df8c2836c42cd22537976533fbf8220d31f99ae4847",
      status: "failed",
      code: "provider-timeout",
    });
    const { container } = renderChat(state);
    expect(container.textContent).toContain(OPERATOR_DELIVERY_FALLBACK);
    expect(container.textContent).not.toContain("dl-11743");
    expect(container.textContent).not.toContain("…");
  });

  it("renders plain prose carrying a trusted inlined image asset instead of the fallback", () => {
    const source = "Inspect ![chart](./chart.png) before deciding whether to release.";
    const certified = "The chart supports keeping the release undeployed. ![chart](./chart.png)";
    const state = reduceEvent(createInitialState(), {
      eventType: "message_end",
      timestamp: 3,
      data: {
        message: {
          role: "assistant",
          audience: "operator",
          content: source,
          operatorDelivery: {
            version: 1,
            sourceSha256: sha256Hex(source),
            status: "ready",
            text: certified,
            checks: { plain: true, anchorsPreserved: true },
          },
          operatorDeliveryPresentation: {
            version: 1,
            deliverySha256: sha256Hex(certified),
            text: "The chart supports keeping the release undeployed. ![chart](pi-asset:abc12345def67890)",
          },
        },
      },
    } as DashboardEvent);
    const { container } = renderChat(state);
    expect(container.textContent).toContain("The chart supports keeping the release undeployed.");
    expect(container.textContent).not.toContain(OPERATOR_DELIVERY_FALLBACK);
    expect(container.textContent).not.toContain("./chart.png");
  });

  it("keeps an unstamped final delivery visible when mesh chatter is hidden in an agent session", () => {
    const sessionId = "unstamped-final-agent-session";
    window.localStorage.setItem(`dashboard:messageFilter:${sessionId}`, JSON.stringify({
      tierA: true,
      tierB: true,
      tierC: true,
      meshChatter: false,
      toolCalls: true,
      systemNotifications: true,
    }));
    const source = "Internal source that must not be shown.";
    const state = reduceEvent({ ...createInitialState(), audience: "agent" }, {
      eventType: "message_end",
      timestamp: 3,
      data: {
        message: {
          role: "assistant",
          content: source,
          operatorDelivery: {
            version: 1,
            sourceSha256: sha256Hex(source),
            status: "ready",
            text: PLAIN,
            checks: { plain: true, anchorsPreserved: true },
          },
        },
      },
    } as DashboardEvent);
    const { container } = renderChat(state, sessionId);
    expect(state.messages[0]?.audience).toBe("unknown");
    expect(container.textContent).toContain(PLAIN);
    expect(container.textContent).not.toContain(source);
  });

  it("keeps the timeout fallback visible when mesh chatter is hidden in an agent session", () => {
    const sessionId = "timeout-agent-session";
    window.localStorage.setItem(`dashboard:messageFilter:${sessionId}`, JSON.stringify({
      tierA: true,
      tierB: true,
      tierC: true,
      meshChatter: false,
      toolCalls: true,
      systemNotifications: true,
    }));
    const state = releaseAssistantBufferAsFallback({
      ...createInitialState(),
      audience: "agent",
      heldOperatorText: SOURCE,
      heldBufferLastActivityAt: 1,
    }, 30_001);
    const { container } = renderChat(state, sessionId);
    expect(state.messages[0]?.audience).toBe("unknown");
    expect(container.textContent).toContain(OPERATOR_DELIVERY_FALLBACK);
    expect(container.textContent).not.toContain("dl-11743");
  });
});
