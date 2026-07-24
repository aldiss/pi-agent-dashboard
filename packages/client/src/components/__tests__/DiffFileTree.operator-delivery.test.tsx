// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { DiffFileTree } from "../DiffFileTree.js";
import { extractFileChanges } from "../../../../server/src/session-diff.js";
import { sha256Hex } from "@blackbelt-technology/pi-dashboard-shared/operator-delivery.js";
import type { DashboardEvent } from "@blackbelt-technology/pi-dashboard-shared/types.js";

afterEach(cleanup);

describe("DiffFileTree operator delivery boundary", () => {
  it("renders verified plain file context without raw source in text or title", () => {
    const source = "Per dl-11743 §2A, CODENAME-47 failed. Decision: do not deploy.";
    const plain = "The final review failed. Do not deploy.";
    const events: DashboardEvent[] = [
      {
        eventType: "message_end",
        timestamp: 1,
        data: {
          message: {
            role: "assistant",
            audience: "agent",
            content: source,
            operatorDelivery: {
              version: 1,
              sourceSha256: sha256Hex(source),
              status: "ready",
              text: plain,
              checks: { plain: true, anchorsPreserved: true },
            },
          },
        },
      } as DashboardEvent,
      {
        eventType: "tool_execution_start",
        timestamp: 2,
        data: { toolName: "Write", toolCallId: "write-1", args: { path: "src/file.ts", content: "x" } },
      } as DashboardEvent,
      {
        eventType: "tool_execution_start",
        timestamp: 3,
        data: { toolName: "Edit", toolCallId: "edit-1", args: { path: "src/file.ts", edits: [] } },
      } as DashboardEvent,
    ];
    const files = extractFileChanges(events, "/project");
    const { container } = render(createElement(DiffFileTree, {
      files,
      selection: null,
      onSelect: vi.fn(),
    }));
    fireEvent.click([...container.querySelectorAll("span")].find((node) => node.textContent === "file.ts")!);
    expect(container.textContent).toContain("The final review failed");
    expect(container.textContent).not.toContain("dl-11743");
    expect(container.textContent).not.toContain("CODENAME-47");
    expect(container.querySelector(`[title="${plain}"]`)).not.toBeNull();
    expect([...container.querySelectorAll("[title]")].every((node) =>
      !node.getAttribute("title")?.includes("dl-11743"),
    )).toBe(true);
  });

  it("uses a plain image label in file context text and title", () => {
    const source = "Attach the release chart before editing.";
    const asset = "pi-asset:0123456789abcdef";
    const plain = `See ![release chart](${asset}) before editing.`;
    const events: DashboardEvent[] = [
      {
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
              text: plain,
              checks: { plain: true, anchorsPreserved: true },
            },
          },
        },
      } as DashboardEvent,
      {
        eventType: "tool_execution_start",
        timestamp: 2,
        data: { toolName: "Write", toolCallId: "write-asset", args: { path: "src/chart.ts", content: "x" } },
      } as DashboardEvent,
      {
        eventType: "tool_execution_start",
        timestamp: 3,
        data: { toolName: "Edit", toolCallId: "edit-asset", args: { path: "src/chart.ts", edits: [] } },
      } as DashboardEvent,
    ];
    const files = extractFileChanges(events, "/project");
    const { container } = render(createElement(DiffFileTree, {
      files,
      selection: null,
      onSelect: vi.fn(),
    }));
    fireEvent.click([...container.querySelectorAll("span")].find((node) => node.textContent === "chart.ts")!);
    expect(container.textContent).toContain("[image: release chart]");
    expect(container.textContent).not.toContain("pi-asset:");
    expect([...container.querySelectorAll("[title]")].every((node) =>
      !node.getAttribute("title")?.includes("pi-asset:"),
    )).toBe(true);
  });
});
