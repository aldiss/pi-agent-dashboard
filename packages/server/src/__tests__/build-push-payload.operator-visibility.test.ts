import { describe, expect, it } from "vitest";
import { buildPushPayload } from "../push/build-push-payload.js";
import type { DashboardEvent, DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";

describe("push payload operator visibility", () => {
  it("uses a plain question label without exposing the internal tool identifier", () => {
    const session = {
      id: "session-1",
      name: "Release review",
      currentTool: "ask_user",
    } as DashboardSession;
    const event = {
      eventType: "tool_execution_start",
      timestamp: 1,
      data: { toolName: "ask_user" },
    } as DashboardEvent;

    const payload = buildPushPayload(session, event);

    expect(payload.title).toBe("Response needed");
    expect(payload.body).toContain("waiting for your response (Question)");
    expect(JSON.stringify(payload)).not.toContain("ask_user");
  });

  it("omits unknown internal tool names instead of putting them in notification prose", () => {
    const session = { id: "session-2", name: "Release review" } as DashboardSession;
    const event = {
      eventType: "tool_execution_start",
      timestamp: 1,
      data: { toolName: "private_internal_tool_47" },
    } as DashboardEvent;
    const payload = buildPushPayload(session, event);
    expect(payload.body).toBe("Release review — waiting for your response");
    expect(JSON.stringify(payload)).not.toContain("private_internal_tool_47");
  });

  it("uses the fixed device-notification label for the protected push tool", () => {
    const session = {
      id: "session-push",
      name: "Release review",
      currentTool: "push_notify_user",
    } as DashboardSession;
    const event = {
      eventType: "tool_execution_start",
      timestamp: 1,
      data: { toolName: "push_notify_user" },
    } as DashboardEvent;

    const payload = buildPushPayload(session, event);
    expect(payload.title).toBe("Device notification");
    expect(payload.body).toBe("Release review — sent a device notification");
    expect(JSON.stringify(payload)).not.toContain("push_notify_user");
  });

  it("uses a neutral name instead of an internal session id", () => {
    const session = { id: "dl-11743-internal-session", currentTool: "ask_user" } as DashboardSession;
    const event = {
      eventType: "tool_execution_start",
      timestamp: 1,
      data: { toolName: "ask_user" },
    } as DashboardEvent;
    const payload = buildPushPayload(session, event);
    expect(payload.body).toBe("This session — waiting for your response (Question)");
    expect(payload.title).not.toContain("dl-11743");
    expect(payload.body).not.toContain("dl-11743");
  });
});
