import { describe, expect, it } from "vitest";
import {
  operatorProseToolLabel,
  sanitizeOperatorProseToolArgs,
  sanitizeOperatorProseToolWireEvent,
} from "../operator-tool-visibility.js";

const RAW = {
  title: "CommsReset asks about dl-11743",
  body: "Per §2A, do not deploy.",
  method: "select",
  options: ["Track 2", "Door-3"],
};

describe("operator prose tool visibility", () => {
  it("uses fixed plain labels", () => {
    expect(operatorProseToolLabel("ask_user")).toBe("Question");
    expect(operatorProseToolLabel("push_notify_user")).toBe("Device notification");
    expect(operatorProseToolLabel("bash")).toBeUndefined();
  });

  it("retains only the non-prose ask method and no push arguments", () => {
    expect(sanitizeOperatorProseToolArgs("ask_user", RAW)).toEqual({ method: "select" });
    expect(sanitizeOperatorProseToolArgs("push_notify_user", RAW)).toBeUndefined();
  });

  it.each([
    ["tool_execution_start", "args"],
    ["tool_call", "input"],
  ] as const)("clones and sanitizes protected %s without mutating core data", (eventType, field) => {
    const event = {
      type: eventType,
      toolName: "ask_user",
      toolCallId: "ask-1",
      [field]: RAW,
      extra: "source prose must not cross",
    };
    const wire = sanitizeOperatorProseToolWireEvent(eventType, event);

    expect(wire).not.toBe(event);
    expect(wire[field]).toEqual({ method: "select" });
    expect(JSON.stringify(wire)).not.toMatch(/CommsReset|dl-11743|§2A|Track 2|Door-3|source prose/u);
    expect(event[field]).toBe(RAW);
    expect(RAW.title).toContain("dl-11743");
  });

  it("makes a protected tool_result status-only", () => {
    const event = {
      type: "tool_result",
      toolName: "push_notify_user",
      toolCallId: "push-1",
      result: RAW,
      details: RAW,
      isError: true,
    };
    expect(sanitizeOperatorProseToolWireEvent("tool_result", event)).toEqual({
      type: "tool_result",
      toolName: "push_notify_user",
      toolCallId: "push-1",
      isError: true,
    });
    expect(event.result).toBe(RAW);
  });

  it.each(["tool_execution_update", "tool_execution_end"])(
    "makes a protected %s status-only without mutating result data",
    (eventType) => {
      const event = {
        type: eventType,
        toolName: "push_notify_user",
        toolCallId: "push-1",
        partialResult: RAW,
        result: RAW,
        details: RAW,
        images: [RAW],
        isError: true,
      };
      const wire = sanitizeOperatorProseToolWireEvent(eventType, event);
      expect(wire).toEqual({
        type: eventType,
        toolName: "push_notify_user",
        toolCallId: "push-1",
        ...(eventType === "tool_execution_end" ? { isError: true } : {}),
      });
      expect(event.result).toBe(RAW);
      expect(event.details).toBe(RAW);
      expect(event.images).toEqual([RAW]);
    },
  );

  it("returns unrelated events unchanged", () => {
    const event = { type: "tool_call", toolName: "bash", input: RAW };
    expect(sanitizeOperatorProseToolWireEvent("tool_call", event)).toBe(event);
  });
});
