// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { PinnedMessagesSection } from "../PinnedMessagesSection.js";
import { ChatView } from "../ChatView.js";
import { ThemeProvider } from "../ThemeProvider.js";
import { createInitialState, reduceEvent, type ChatMessage } from "../../lib/event-reducer.js";
import type { ToolContext } from "../tool-renderers/index.js";
import type { DashboardEvent } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import { StatusBar } from "../StatusBar.js";
import { OPERATOR_DELIVERY_FALLBACK, sha256Hex } from "../../lib/operator-delivery.js";

const CONTENT = "Keep the release undeployed. ![chart](pi-asset:abc12345def67890)";
const PRESENTED = "Keep the release undeployed. [image: chart]";
const message: ChatMessage = {
  id: "plain-with-image",
  role: "assistant",
  content: CONTENT,
  timestamp: 1,
  entryId: "entry-1",
  audience: "operator",
};
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

afterEach(cleanup);

describe("operator delivery presentation", () => {
  it("uses a plain image label in pinned-message previews", () => {
    const { container } = render(createElement(PinnedMessagesSection, {
      sessionId: "presentation-pin",
      entries: [message],
      pinnedEntryIds: new Set(["entry-1"]),
      onUnpinAll: vi.fn(),
      onScrollToMessage: vi.fn(),
      onTogglePin: vi.fn(),
    }));
    expect(container.textContent).toContain(PRESENTED);
    expect(container.textContent).not.toContain("pi-asset:");
  });

  it("copies Markdown without exposing the transport asset id", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const state = createInitialState();
    state.messages = [message];
    const { container } = render(createElement(
      ThemeProvider,
      null,
      createElement(ChatView, { state, toolContext }),
    ));
    const copyMarkdown = container.querySelector('button[title="Copy as Markdown"]');
    expect(copyMarkdown).not.toBeNull();
    fireEvent.click(copyMarkdown!);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(PRESENTED));
    expect(writeText).not.toHaveBeenCalledWith(expect.stringContaining("pi-asset:"));
  });

  it("uses a fixed loading title without exposing an unresolved asset hash", () => {
    const unresolved: ChatMessage = {
      ...message,
      id: "unresolved-image",
      content: "![chart](pi-asset:abc12345def67890)",
    };
    const state = createInitialState();
    state.messages = [unresolved];
    const { container } = render(createElement(
      ThemeProvider,
      null,
      createElement(ChatView, { state, toolContext }),
    ));
    const placeholder = container.querySelector('[title="Image is still loading"]');
    expect(placeholder).not.toBeNull();
    expect(container.innerHTML).not.toContain("abc12345def67890");
    expect(container.innerHTML).not.toContain("pi-asset:");
  });

  it("falls back instead of rendering a delivery with bare, link, or HTML transport ids", () => {
    const source = "Door-3 attached several internal assets.";
    const delivered = [
      "![chart](pi-asset:abc12345def67890)",
      "bare pi-asset:0123456789abcdef",
      "[link](pi-asset:fedcba9876543210)",
      '<img src="pi-asset:1111222233334444">',
    ].join(" ");
    const state = reduceEvent(createInitialState(), {
      eventType: "message_end",
      timestamp: 1,
      data: {
        message: {
          role: "assistant",
          audience: "operator",
          content: source,
          operatorDelivery: {
            version: 1,
            sourceSha256: sha256Hex(source),
            status: "ready",
            text: delivered,
            checks: { plain: true, anchorsPreserved: true },
          },
        },
      },
    } as DashboardEvent);
    const { container } = render(createElement(
      ThemeProvider,
      null,
      createElement(ChatView, { state, toolContext }),
    ));
    expect(container.innerHTML).not.toMatch(/pi-asset:/i);
    expect(container.textContent).toContain(OPERATOR_DELIVERY_FALLBACK);
  });

  it("scrubs malformed ids and ids in image alt text at the final assistant renderer", () => {
    const state = createInitialState();
    state.messages = [{
      ...message,
      id: "adversarial-assets",
      content: [
        "![pi-asset:0123456789abcdef](pi-asset:abc12345def67890)",
        "bare PI-ASSET:not-a-hash",
        "[link](pi-asset:fedcba9876543210)",
        '<img src="pi-asset:1111222233334444">',
      ].join(" "),
    }];
    const { container } = render(createElement(
      ThemeProvider,
      null,
      createElement(ChatView, { state, toolContext }),
    ));
    expect(container.innerHTML).not.toMatch(/pi-asset:/i);
    expect(container.innerHTML).not.toMatch(/0123456789abcdef|not-a-hash|fedcba9876543210|1111222233334444/i);
    expect(container.textContent).toContain("attached image");
  });

  it.each([
    ["ask_user", "Question", { method: "select", title: "CommsReset dl-11743", options: ["Track 2"] }],
    ["push_notify_user", "Device notification", { title: "Door-3", body: "Per §2A" }],
  ] as const)("renders %s lifecycle as status-only plain chrome", (toolName, label, rawArgs) => {
    const frames: DashboardEvent[] = [
      {
        eventType: "tool_execution_start",
        timestamp: 1,
        data: { toolCallId: `${toolName}-1`, toolName, args: rawArgs },
      } as DashboardEvent,
      {
        eventType: "tool_execution_update",
        timestamp: 2,
        data: { toolCallId: `${toolName}-1`, partialResult: JSON.stringify(rawArgs) },
      } as DashboardEvent,
      {
        eventType: "tool_execution_end",
        timestamp: 3,
        data: {
          toolCallId: `${toolName}-1`,
          toolName,
          result: JSON.stringify(rawArgs),
          details: rawArgs,
          images: [rawArgs],
          isError: false,
        },
      } as DashboardEvent,
      {
        eventType: "tool_call",
        timestamp: 4,
        data: { type: "tool_call", toolCallId: `${toolName}-1`, toolName, input: rawArgs },
      } as DashboardEvent,
      {
        eventType: "tool_result",
        timestamp: 5,
        data: { type: "tool_result", toolCallId: `${toolName}-1`, toolName, result: rawArgs },
      } as DashboardEvent,
      {
        eventType: "future_tool_lifecycle_debug",
        timestamp: 6,
        data: { toolCallId: `${toolName}-1`, result: rawArgs, details: rawArgs, images: [rawArgs] },
      } as DashboardEvent,
    ];
    const state = frames.reduce(reduceEvent, createInitialState());
    const row = state.messages.find((candidate) => candidate.toolCallId === `${toolName}-1`);
    expect(row).toEqual(expect.objectContaining({
      content: label,
      result: undefined,
      toolDetails: undefined,
      images: undefined,
    }));
    expect(row?.args).toEqual(toolName === "ask_user" ? { method: "select" } : undefined);
    expect(state.messages.some((candidate) => candidate.role === "rawEvent")).toBe(false);

    const { container } = render(createElement(
      ThemeProvider,
      null,
      createElement(ChatView, { state, toolContext }),
    ));
    const showAll = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Show all activity"));
    if (showAll) fireEvent.click(showAll);
    expect(container.textContent).toContain(label);
    expect(container.textContent).not.toContain(toolName);
    expect(container.innerHTML).not.toMatch(/CommsReset|dl-11743|Track 2|Door-3|§2A/u);
  });

  it("uses the fixed protected label in status chrome", () => {
    const { container } = render(createElement(StatusBar, {
      status: "streaming",
      currentTool: "push_notify_user",
      onSelectModel: vi.fn(),
      onSelectThinkingLevel: vi.fn(),
    }));
    expect(container.textContent).toContain("Device notification");
    expect(container.textContent).not.toContain("push_notify_user");
  });
});
