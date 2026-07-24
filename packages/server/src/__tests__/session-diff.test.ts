import { describe, it, expect } from "vitest";
import { extractFileChanges } from "../session-diff.js";
import type { DashboardEvent } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import { OPERATOR_DELIVERY_FALLBACK, sha256Hex } from "@blackbelt-technology/pi-dashboard-shared/operator-delivery.js";

function makeEvent(eventType: string, timestamp: number, data: Record<string, unknown> = {}): DashboardEvent {
  return { eventType, timestamp, data: { type: eventType, ...data } };
}

function makeToolStart(toolName: string, args: Record<string, unknown>, timestamp = 1000): DashboardEvent {
  return makeEvent("tool_execution_start", timestamp, { toolName, toolCallId: `tc-${timestamp}`, args });
}

function makeMessageEnd(text: string, timestamp = 900, options: {
  plain?: string;
  audience?: "operator" | "agent";
  withoutDelivery?: boolean;
} = {}): DashboardEvent {
  const plain = options.plain ?? text;
  return makeEvent("message_end", timestamp, {
    message: {
      role: "assistant",
      audience: options.audience ?? "operator",
      content: [{ type: "text", text }],
      ...(!options.withoutDelivery ? {
        operatorDelivery: {
          version: 1,
          sourceSha256: sha256Hex(text),
          status: "ready",
          text: plain,
          checks: { plain: true, anchorsPreserved: true },
        },
      } : {}),
    },
  });
}

describe("extractFileChanges", () => {
  const cwd = "/project";

  it("should extract Write tool events", () => {
    const events = [
      makeToolStart("Write", { path: "src/foo.ts", content: "hello world" }, 1000),
    ];
    const result = extractFileChanges(events, cwd);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("src/foo.ts");
    expect(result[0].changes).toHaveLength(1);
    expect(result[0].changes[0].type).toBe("write");
    expect(result[0].changes[0].content).toBe("hello world");
    expect(result[0].changes[0].timestamp).toBe(1000);
  });

  it("should extract Edit tool events", () => {
    const edits = [{ oldText: "foo", newText: "bar" }];
    const events = [
      makeToolStart("Edit", { path: "src/bar.ts", edits }, 2000),
    ];
    const result = extractFileChanges(events, cwd);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("src/bar.ts");
    expect(result[0].changes[0].type).toBe("edit");
    expect(result[0].changes[0].edits).toEqual(edits);
  });

  it("should be case-insensitive for tool names", () => {
    const events = [
      makeToolStart("write", { path: "a.ts", content: "x" }, 1000),
      makeToolStart("EDIT", { path: "b.ts", edits: [{ oldText: "a", newText: "b" }] }, 2000),
    ];
    const result = extractFileChanges(events, cwd);
    expect(result).toHaveLength(2);
  });

  it("should support file_path arg alias", () => {
    const events = [
      makeToolStart("Write", { file_path: "src/alt.ts", content: "x" }, 1000),
    ];
    const result = extractFileChanges(events, cwd);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("src/alt.ts");
  });

  it("should group multiple changes to same file", () => {
    const events = [
      makeToolStart("Write", { path: "src/foo.ts", content: "v1" }, 1000),
      makeToolStart("Edit", { path: "src/foo.ts", edits: [{ oldText: "v1", newText: "v2" }] }, 2000),
    ];
    const result = extractFileChanges(events, cwd);
    expect(result).toHaveLength(1);
    expect(result[0].changes).toHaveLength(2);
    expect(result[0].changes[0].type).toBe("write");
    expect(result[0].changes[1].type).toBe("edit");
  });

  it("should order changes by timestamp", () => {
    const events = [
      makeToolStart("Edit", { path: "src/foo.ts", edits: [{ oldText: "a", newText: "b" }] }, 3000),
      makeToolStart("Write", { path: "src/foo.ts", content: "init" }, 1000),
    ];
    const result = extractFileChanges(events, cwd);
    expect(result[0].changes[0].timestamp).toBe(1000);
    expect(result[0].changes[1].timestamp).toBe(3000);
  });

  it("should filter out absolute paths outside cwd", () => {
    const events = [
      makeToolStart("Write", { path: "/tmp/scratch.ts", content: "x" }, 1000),
      makeToolStart("Write", { path: "/project/src/inside.ts", content: "y" }, 2000),
      makeToolStart("Write", { path: "src/relative.ts", content: "z" }, 3000),
    ];
    const result = extractFileChanges(events, cwd);
    expect(result).toHaveLength(2);
    expect(result.map((f) => f.path).sort()).toEqual(["src/inside.ts", "src/relative.ts"]);
  });

  it("should extract preceding assistant message as context", () => {
    const events = [
      makeMessageEnd("I'll create the file now", 900),
      makeToolStart("Write", { path: "src/foo.ts", content: "hello" }, 1000),
    ];
    const result = extractFileChanges(events, cwd);
    expect(result[0].changes[0].message).toBe("I'll create the file now");
  });

  it("should truncate long context messages to 120 chars", () => {
    const longMsg = "A".repeat(200);
    const events = [
      makeMessageEnd(longMsg, 900),
      makeToolStart("Write", { path: "src/foo.ts", content: "hello" }, 1000),
    ];
    const result = extractFileChanges(events, cwd);
    expect(result[0].changes[0].message!.length).toBeLessThanOrEqual(123); // 120 + "..."
  });

  it("uses verified plain context and never leaks source, including agent-stamped rows", () => {
    const source = "Per dl-11743 §2A, CODENAME-47 failed. Decision: do not deploy.";
    const plain = "The final review failed. Do not deploy.";
    for (const audience of ["operator", "agent"] as const) {
      const result = extractFileChanges([
        makeMessageEnd(source, 900, { plain, audience }),
        makeToolStart("Write", { path: `${audience}.ts`, content: "hello" }, 1000),
      ], cwd);
      expect(result[0].changes[0].message).toBe(plain);
      expect(result[0].changes[0].message).not.toContain("dl-11743");
      expect(result[0].changes[0].message).not.toContain("CODENAME-47");
    }
  });

  it("uses the exact fallback when file context has no valid delivery", () => {
    const source = "Per dl-11743 §2A, CODENAME-47 failed.";
    const result = extractFileChanges([
      makeMessageEnd(source, 900, { withoutDelivery: true, audience: "agent" }),
      makeToolStart("Edit", { path: "src/foo.ts", edits: [] }, 1000),
    ], cwd);
    expect(result[0].changes[0].message).toBe(OPERATOR_DELIVERY_FALLBACK);
    expect(result[0].changes[0].message).not.toContain("dl-11743");
  });

  it("should ignore non-Write/Edit tool events", () => {
    const events = [
      makeToolStart("Read", { path: "src/foo.ts" }, 1000),
      makeToolStart("Bash", { command: "ls" }, 2000),
    ];
    const result = extractFileChanges(events, cwd);
    expect(result).toHaveLength(0);
  });

  it("should skip events with no path", () => {
    const events = [
      makeToolStart("Write", { content: "no path" }, 1000),
    ];
    const result = extractFileChanges(events, cwd);
    expect(result).toHaveLength(0);
  });

  it("should return empty array for empty events", () => {
    const result = extractFileChanges([], cwd);
    expect(result).toHaveLength(0);
  });
});
