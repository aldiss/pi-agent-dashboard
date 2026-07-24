import { describe, expect, it } from "vitest";
import type { DashboardEvent } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import { replayEntriesAsEvents } from "@blackbelt-technology/pi-dashboard-shared/state-replay.js";
import { createMemoryEventStore } from "../../../server/src/memory-event-store.js";
import { OperatorToolWireTracker } from "../operator-tool-wire-tracker.js";

const RAW = {
  method: "select",
  title: "CommsReset asks about dl-11743",
  options: ["Track 2", "Door-3"],
  body: "Per §2A, keep the release undeployed.",
};

describe("protected operator tool wire lifecycle", () => {
  it("keeps name-less live update/end frames status-only through storage", () => {
    const tracker = new OperatorToolWireTracker();
    const originals = [
      { toolCallId: "ask-1", toolName: "ask_user", args: RAW },
      { toolCallId: "ask-1", partialResult: RAW, details: RAW, images: [RAW] },
      { toolCallId: "ask-1", result: RAW, details: RAW, images: [RAW], isError: false },
      // A late duplicate after end is still protected until id reuse/session reset.
      { toolCallId: "ask-1", partialResult: RAW },
    ];
    const types = [
      "tool_execution_start",
      "tool_execution_update",
      "tool_execution_end",
      "tool_execution_update",
    ];
    const wire = originals.map((event, index) => tracker.sanitize(types[index], event));

    expect(wire[0]).toEqual({
      type: undefined,
      toolCallId: "ask-1",
      toolName: "ask_user",
      args: { method: "select" },
    });
    expect(wire.slice(1)).toEqual([
      { type: undefined, toolCallId: "ask-1", toolName: "ask_user" },
      { type: undefined, toolCallId: "ask-1", toolName: "ask_user", isError: false },
      { type: undefined, toolCallId: "ask-1", toolName: "ask_user" },
    ]);
    expect(JSON.stringify(wire)).not.toMatch(/CommsReset|dl-11743|Track 2|Door-3|§2A/u);
    expect(originals[1].details).toBe(RAW);

    const store = createMemoryEventStore(() => false);
    wire.forEach((data, index) => store.insertEvent("session", {
      eventType: types[index],
      timestamp: index,
      data,
    } as DashboardEvent));
    expect(JSON.stringify(store.getEvents("session", 1))).not.toMatch(
      /CommsReset|dl-11743|Track 2|Door-3|§2A/u,
    );
  });

  it("retains protected correlation for the whole session instead of evicting old ids", () => {
    const tracker = new OperatorToolWireTracker();
    tracker.sanitize("tool_execution_start", {
      toolCallId: "oldest",
      toolName: "push_notify_user",
      args: RAW,
    });
    for (let index = 0; index < 1_100; index++) {
      tracker.sanitize("tool_execution_start", {
        toolCallId: `newer-${index}`,
        toolName: "ask_user",
        args: RAW,
      });
    }

    expect(tracker.sanitize("tool_execution_end", {
      toolCallId: "oldest",
      result: RAW,
      details: RAW,
      images: [RAW],
      isError: true,
    })).toEqual({
      type: undefined,
      toolCallId: "oldest",
      toolName: "push_notify_user",
      isError: true,
    });
  });

  it("uses tracked identity to strip a live toolResult frame with no toolName", () => {
    const tracker = new OperatorToolWireTracker();
    tracker.sanitize("tool_execution_start", {
      toolCallId: "ask-with-name",
      toolName: "ask_user",
      args: RAW,
    });
    const message = {
      role: "toolResult",
      toolCallId: "ask-with-name",
      content: [{ type: "text", text: JSON.stringify(RAW) }],
      details: RAW,
      images: [RAW],
      isError: true,
    };

    const wire = tracker.sanitizeMessage(message);
    expect(wire).toEqual({
      role: "toolResult",
      toolCallId: "ask-with-name",
      toolName: "ask_user",
      isError: true,
      content: "",
    });
    expect(JSON.stringify(wire)).not.toMatch(/CommsReset|dl-11743|Track 2|Door-3|§2A/u);
    expect(message.content[0].text).toContain("CommsReset");
  });

  it("removes protected tool-call prose from replay message frames and results", () => {
    const entries = [
      {
        id: "assistant-1",
        type: "message",
        timestamp: new Date(1).toISOString(),
        message: {
          role: "assistant",
          content: [{
            type: "toolCall",
            id: "ask-1",
            name: "ask_user",
            arguments: RAW,
            details: RAW,
          }],
        },
      },
      {
        id: "result-1",
        type: "message",
        timestamp: new Date(2).toISOString(),
        message: {
          role: "toolResult",
          toolCallId: "ask-1",
          toolName: "ask_user",
          content: [{ type: "text", text: JSON.stringify(RAW) }],
          details: RAW,
        },
      },
    ];
    const replay = replayEntriesAsEvents("session", entries);
    const serialized = JSON.stringify(replay);
    expect(serialized).not.toMatch(/CommsReset|dl-11743|Track 2|Door-3|§2A/u);
    expect(replay.find(({ event }) => event.eventType === "tool_execution_start")?.event.data)
      .toMatchObject({ toolName: "ask_user", args: undefined });
    expect(replay.find(({ event }) => event.eventType === "tool_execution_end")?.event.data)
      .toMatchObject({ toolName: "ask_user", result: "" });
  });
});
