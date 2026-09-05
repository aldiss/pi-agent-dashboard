import { describe, expect, it } from "vitest";
import { createInitialState, reduceEvent } from "../../../../client/src/lib/event-reducer.js";
import { extractSessionUpdates, extractStatsFromEvents } from "../../event-status-extraction.js";
import { createCodexEventMapper } from "../codex-event-mapper.js";
import type { RuntimeEvent } from "../types.js";

function fixture(initialStats?: { tokensIn?: number; tokensOut?: number; cacheRead?: number }) {
  const events: RuntimeEvent[] = [];
  let state = { ...createInitialState(), ...initialStats };
  let session: Record<string, unknown> = {};
  const mapper = createCodexEventMapper({
    initialStats,
    emit(event) {
      events.push(event);
      state = reduceEvent(state, event);
      session = { ...session, ...extractSessionUpdates(event) };
    },
  });
  const notify = (method: string, params: Record<string, unknown>) => mapper.handleNotification(method, { threadId: "thread", turnId: "turn", ...params });
  return { mapper, notify, events, state: () => state, session: () => session };
}

const command = { type: "commandExecution", id: "cmd", command: "printf hello", cwd: "/workspace", status: "inProgress", aggregatedOutput: null, exitCode: null };

describe("Codex events through dashboard reducer and status extraction", () => {
  it("commits raw user text/images with separate server attribution and queue correlation", () => {
    const f = fixture();
    const author = { sub: "operator@example.com", display: "Operator" };
    const images = [{ type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" }];
    f.mapper.beginTurn({ text: "Remember the word maple", author, images, queueNonce: "queue-1" });
    expect(f.events.map(event => event.eventType)).toEqual(["agent_start", "message_start", "message_end"]);
    expect(f.events[1].data).toMatchObject({ author, queueNonce: "queue-1" });
    expect(f.state().messages).toHaveLength(1);
    expect(f.state().messages[0]).toMatchObject({ role: "user", content: "Remember the word maple", author, images: [{ data: "aW1hZ2U=", mimeType: "image/png" }] });
    expect(f.session()).toMatchObject({ status: "streaming", currentTool: null });
    expect(JSON.stringify(f.events)).not.toContain("<speaker");
    f.notify("item/started", { item: { type: "userMessage", id: "user", content: [{ type: "text", text: "Remember the word maple", text_elements: [] }] } });
    f.notify("item/completed", { item: { type: "userMessage", id: "user", content: [] } });
    expect(f.state().messages).toHaveLength(1);
  });

  it("accumulates deltas into snapshots and syncs authoritative final text before message_end", () => {
    const f = fixture();
    f.mapper.beginTurn({ text: "hello" });
    f.notify("item/started", { item: { type: "agentMessage", id: "answer", text: "" } });
    f.notify("item/agentMessage/delta", { itemId: "answer", delta: "Hel" });
    expect(f.state().streamingText).toBe("Hel");
    f.notify("item/agentMessage/delta", { itemId: "answer", delta: "lo" });
    expect(f.state().streamingText).toBe("Hello");
    f.notify("item/completed", { item: { type: "agentMessage", id: "answer", text: "Hello!" } });
    expect(f.events.at(-2)).toMatchObject({ eventType: "message_update", data: { message: { content: [{ type: "text", text: "Hello!" }] } } });
    expect(f.state().messages.filter(message => message.role === "assistant").map(message => message.content)).toEqual(["Hello!"]);
    f.notify("item/completed", { item: { type: "agentMessage", id: "answer", text: "Hello!" } });
    expect(f.state().messages.filter(message => message.role === "assistant")).toHaveLength(1);
    f.notify("turn/completed", { turn: { id: "turn", status: "completed", items: [], error: null } });
    expect(f.events.at(-1)?.eventType).toBe("agent_end");
    expect(f.state()).toMatchObject({ isStreaming: false, status: "idle", streamingText: "" });
    expect(f.events.some(event => event.eventType === "turn_end")).toBe(false);
  });

  it("reconciles completion-only identity changes with the sole started assistant lifecycle", () => {
    const f = fixture();
    f.mapper.beginTurn({ text: "hello" });
    f.notify("item/started", { item: { type: "agentMessage", id: "stream-id", phase: "final_answer", text: "" } });
    f.notify("item/agentMessage/delta", { itemId: "stream-id", delta: "Hel" });
    expect(f.state().streamingText).toBe("Hel");
    const completed = { type: "agentMessage", id: "completed-id", phase: "final_answer", text: "Hello!" };
    f.notify("item/completed", { item: completed });
    expect(f.state().messages.filter(message => message.role === "assistant").map(message => message.content)).toEqual(["Hello!"]);
    expect(f.events.filter(event => event.eventType === "message_end" && event.data.message?.role === "assistant")).toHaveLength(1);
    expect(f.state().messages.at(-1)?.nonce).toMatch(/-stream-id$/);
    f.notify("item/completed", { item: completed });
    f.notify("item/completed", { item: { ...completed, id: "stream-id" } });
    f.notify("turn/completed", { turn: { id: "turn", status: "completed", items: [completed], error: null } });
    expect(f.state().messages.filter(message => message.role === "assistant")).toHaveLength(1);
    expect(f.state()).toMatchObject({ isStreaming: false, status: "idle", streamingText: "" });
  });

  it.each([false, true])("preserves separately started identical replies (separate turns: %s)", (separateTurns) => {
    const f = fixture();
    for (let index = 0; index < 2; index++) {
      if (index === 0 || separateTurns) f.mapper.beginTurn({ text: "repeat" });
      const id = separateTurns ? "stream" : `stream-${index}`;
      f.notify("item/started", { item: { type: "agentMessage", id, phase: "final_answer", text: "" } });
      f.notify("item/agentMessage/delta", { itemId: id, delta: "Same answer" });
      f.notify("item/completed", { item: { type: "agentMessage", id: `${id}-completed`, phase: "final_answer", text: "Same answer" } });
      if (separateTurns) f.mapper.finishTurn();
    }
    if (!separateTurns) f.mapper.finishTurn();
    const messages = f.state().messages.filter(message => message.role === "assistant");
    expect(messages.map(message => message.content)).toEqual(["Same answer", "Same answer"]);
    expect(new Set(messages.map(message => message.nonce)).size).toBe(2);
  });

  it("keeps unmatched completions separate when outstanding assistant identity is ambiguous", () => {
    const f = fixture();
    f.mapper.beginTurn({ text: "repeat" });
    for (const id of ["first", "second"]) {
      f.notify("item/started", { item: { type: "agentMessage", id, phase: "final_answer", text: "" } });
      f.notify("item/agentMessage/delta", { itemId: id, delta: "Same answer" });
    }
    f.notify("item/completed", { item: { type: "agentMessage", id: "third", phase: "final_answer", text: "Same answer" } });
    f.mapper.finishTurn();
    expect(f.state().messages.filter(message => message.role === "assistant").map(message => message.content)).toEqual(["Same answer", "Same answer", "Same answer"]);
  });

  it("does not adopt a completion from a different assistant phase", () => {
    const f = fixture();
    f.mapper.beginTurn({ text: "repeat" });
    f.notify("item/started", { item: { type: "agentMessage", id: "commentary", phase: "commentary", text: "" } });
    f.notify("item/agentMessage/delta", { itemId: "commentary", delta: "Same answer" });
    f.notify("item/completed", { item: { type: "agentMessage", id: "final", phase: "final_answer", text: "Same answer" } });
    f.mapper.finishTurn();
    expect(f.state().messages.filter(message => message.role === "assistant").map(message => message.content)).toEqual(["Same answer", "Same answer"]);
  });

  it("preserves distinct completion-only replies with identical text", () => {
    const f = fixture();
    f.mapper.beginTurn({ text: "repeat" });
    for (const id of ["first", "second"]) {
      f.notify("item/completed", { item: { type: "agentMessage", id, phase: "final_answer", text: "Same answer" } });
    }
    f.mapper.finishTurn();
    expect(f.state().messages.filter(message => message.role === "assistant").map(message => message.content)).toEqual(["Same answer", "Same answer"]);
  });

  it("reasoning summaries stream and close explicitly with authoritative final content", () => {
    const f = fixture();
    f.mapper.beginTurn({ text: "think" });
    f.notify("item/started", { item: { type: "reasoning", id: "reason", summary: [], content: [] } });
    f.notify("item/reasoning/summaryTextDelta", { itemId: "reason", summaryIndex: 0, delta: "Plan" });
    f.notify("item/reasoning/summaryPartAdded", { itemId: "reason", summaryIndex: 1 });
    f.notify("item/reasoning/summaryTextDelta", { itemId: "reason", summaryIndex: 1, delta: "then act" });
    expect(f.state().streamingThinking).toBe("Plan\n\nthen act");
    f.notify("item/completed", { item: { type: "reasoning", id: "reason", summary: ["Plan carefully", "then act"], content: [] } });
    expect(f.state().streamingThinking).toBe("");
    expect(f.state().thinkingStartedAt).toBeUndefined();
    expect(f.state().messages.filter(message => message.role === "thinking").map(message => message.content)).toEqual(["Plan carefully\n\nthen act"]);
    expect(f.events.some(event => event.data.assistantMessageEvent?.type === "thinking_end")).toBe(true);
  });

  it("command output updates remain snapshots and every completed command closes its tool", () => {
    const f = fixture();
    f.mapper.beginTurn({ text: "run" });
    f.notify("item/completed", { item: { type: "agentMessage", id: "intro", text: "Running the check." } });
    f.notify("item/started", { item: command });
    expect(f.session().currentTool).toBe("bash");
    f.notify("item/commandExecution/outputDelta", { itemId: "cmd", delta: "one\n" });
    f.notify("item/commandExecution/outputDelta", { itemId: "cmd", delta: "two\n" });
    expect(f.state().messages.at(-1)).toMatchObject({ role: "toolResult", toolStatus: "running", result: "one\ntwo\n", args: { command: "printf hello" } });
    f.notify("item/completed", { item: { ...command, status: "completed", exitCode: 0, aggregatedOutput: "one\ntwo\nthree\n" } });
    expect(f.state().messages.at(-1)).toMatchObject({ toolStatus: "complete", result: "one\ntwo\nthree\n" });
    expect([...f.state().toolCalls.values()].every(tool => tool.status === "complete")).toBe(true);
    expect(f.state().messages.map(message => message.role)).toEqual(["user", "assistant", "toolResult"]);
    expect(f.session().currentTool).toBeNull();
  });

  it.each([{ status: "completed", exitCode: 2 }, { status: "failed", exitCode: null }, { status: "declined", exitCode: null }])("command failure closes as error: %j", (status) => {
    const f = fixture();
    f.mapper.beginTurn({ text: "run" });
    f.notify("item/started", { item: command });
    f.notify("item/completed", { item: { ...command, ...status, aggregatedOutput: "denied" } });
    expect(f.state().messages.at(-1)).toMatchObject({ toolStatus: "error", result: "denied" });
  });

  it("maps file changes, MCP, dynamic tools and unknown items to finished flat tool cards", () => {
    const f = fixture();
    f.mapper.beginTurn({ text: "tools" });
    f.notify("item/completed", { item: { type: "fileChange", id: "edit", status: "completed", changes: [{ path: "/workspace/a.ts", kind: { type: "update" }, diff: "-old\n+new" }] } });
    expect(f.state().hasFileChanges).toBe(true);
    expect(f.state().messages.at(-1)).toMatchObject({ toolName: "edit", toolStatus: "complete", args: { path: "/workspace/a.ts" } });
    expect(f.state().messages.at(-1)?.result).toContain("+new");
    f.notify("item/completed", { item: { type: "mcpToolCall", id: "mcp", server: "docs", tool: "search", status: "failed", arguments: { query: "x" }, result: null, error: { message: "MCP unavailable" } } });
    expect(f.state().messages.at(-1)).toMatchObject({ toolStatus: "error", result: "MCP unavailable" });
    f.notify("item/completed", { item: { type: "dynamicToolCall", id: "dynamic", tool: "lookup", arguments: {}, status: "completed", success: true, contentItems: [{ type: "inputText", text: "found" }] } });
    expect(f.state().messages.at(-1)).toMatchObject({ toolStatus: "complete", result: "found" });
    f.notify("item/started", { item: { type: "futureItem", id: "unknown", value: "pending" } });
    f.notify("item/completed", { item: { type: "futureItem", id: "unknown", value: "done" } });
    expect(f.state().messages.at(-1)).toMatchObject({ toolStatus: "complete" });
    expect(f.state().messages.at(-1)?.result).toContain("done");
    expect([...f.state().toolCalls.values()].every(tool => tool.status !== "running")).toBe(true);
  });

  it("terminal error closes reasoning, partial prose and every open tool before agent_end exactly once", () => {
    const f = fixture();
    f.mapper.beginTurn({ text: "start" });
    f.notify("item/started", { item: { type: "reasoning", id: "thought", summary: [], content: [] } });
    f.notify("item/reasoning/textDelta", { itemId: "thought", contentIndex: 0, delta: "Considering" });
    f.notify("item/started", { item: command });
    f.notify("item/agentMessage/delta", { itemId: "partial", delta: "Partial response" });
    f.mapper.finishTurn("Transport closed");
    expect(f.state()).toMatchObject({ isStreaming: false, streamingText: "", streamingThinking: "", lastError: { message: "Transport closed" } });
    expect(f.state().messages.some(message => message.role === "assistant" && message.content === "Partial response")).toBe(true);
    expect([...f.state().toolCalls.values()].every(tool => tool.status === "error")).toBe(true);
    expect(f.session()).toMatchObject({ status: "idle", currentTool: null });
    const count = f.events.length;
    f.mapper.finishTurn("duplicate");
    f.notify("item/started", { item: { ...command, id: "late" } });
    expect(f.events).toHaveLength(count);
  });

  it("failed native turns use the reducer's messages[] error shape, not only a string field", () => {
    const f = fixture();
    f.mapper.beginTurn({ text: "start" });
    f.notify("turn/completed", { turn: { id: "turn", items: [], status: "failed", error: { message: "Quota exhausted" } } });
    expect(f.events.at(-1)).toMatchObject({ eventType: "agent_end", data: { error: "Quota exhausted", messages: [{ stopReason: "error", errorMessage: "Quota exhausted" }] } });
    expect(f.state().lastError?.message).toBe("Quota exhausted");
  });

  it("declined approval/user-input requests surface paired errors without ending the active turn", () => {
    const f = fixture();
    f.mapper.beginTurn({ text: "run" });
    f.notify("item/started", { item: command });
    const params = { itemId: "cmd", command: "printf hello" };
    f.mapper.requestDeclined("item/commandExecution/requestApproval", 42, params);
    f.mapper.requestDeclined("item/commandExecution/requestApproval", 42, params);
    expect(f.state().isStreaming).toBe(true);
    const tools = f.state().messages.filter(message => message.role === "toolResult");
    expect(tools).toHaveLength(2);
    expect(tools[0].toolStatus).toBe("running");
    expect(tools[1].toolStatus).toBe("error");
    expect(tools[1].result).toMatch(/declined/i);
    expect(f.events.some(event => event.eventType === "agent_end")).toBe(false);
    f.notify("item/completed", { item: { ...command, status: "declined" } });
    f.notify("turn/completed", { turn: { id: "turn", status: "completed", items: [], error: null } });
    expect(f.state().isStreaming).toBe(false);
    expect(f.state().lastError).toBeUndefined();
  });

  it("reused native item ids in a second turn never overwrite the first turn's cards", () => {
    const f = fixture();
    for (const text of ["first", "second"]) {
      f.mapper.beginTurn({ text });
      f.notify("item/completed", { item: { ...command, status: "completed", exitCode: 0, aggregatedOutput: text } });
      f.mapper.finishTurn();
    }
    const tools = f.state().messages.filter(message => message.role === "toolResult");
    expect(tools.map(tool => tool.result)).toEqual(["first", "second"]);
    expect(new Set(tools.map(tool => tool.toolCallId)).size).toBe(2);
    expect(f.state().messages.filter(message => message.role === "user").map(message => message.content)).toEqual(["first", "second"]);
  });

  it("prose interrupted by a tool preserves both prefix and later suffix without duplicated snapshots", () => {
    const f = fixture();
    f.mapper.beginTurn({ text: "check" });
    f.notify("item/agentMessage/delta", { itemId: "answer", delta: "Checking. " });
    f.notify("item/started", { item: command });
    f.notify("item/completed", { item: { ...command, status: "completed", exitCode: 0, aggregatedOutput: "ok" } });
    f.notify("item/agentMessage/delta", { itemId: "answer", delta: "Finished" });
    expect(f.state().streamingText).toBe("Finished");
    f.notify("item/completed", { item: { type: "agentMessage", id: "answer", text: "Checking. Finished." } });
    expect(f.state().messages.map(message => message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
    expect(f.state().messages.filter(message => message.role === "assistant").map(message => message.content)).toEqual(["Checking. ", "Finished."]);
  });

  it("interrupted completion payloads never mark in-progress tools successful", () => {
    const f = fixture();
    f.mapper.beginTurn({ text: "run until stopped" });
    f.notify("item/started", { item: command });
    f.notify("turn/completed", { turn: { id: "turn", status: "interrupted", items: [{ ...command, aggregatedOutput: "partial" }], error: null } });
    expect(f.state().messages.at(-1)).toMatchObject({ toolStatus: "error" });
    expect(f.state().messages.at(-1)?.result).toContain("partial");
    expect(f.state().messages.at(-1)?.result).toContain("Turn interrupted");
    expect(f.state().lastError).toBeUndefined();
    expect(f.events.at(-1)).toMatchObject({ eventType: "agent_end", data: { messages: [{ role: "assistant", stopReason: "aborted" }] } });
    expect(f.events.at(-1)?.data).not.toHaveProperty("error");
    expect([...f.state().toolCalls.values()].every(tool => tool.status === "error")).toBe(true);
  });

  it("intentional interruption closes partial output and open tools without a provider error", () => {
    const f = fixture();
    f.mapper.beginTurn({ text: "start" });
    f.notify("item/started", { item: { type: "reasoning", id: "thought", summary: [], content: [] } });
    f.notify("item/reasoning/textDelta", { itemId: "thought", contentIndex: 0, delta: "Considering" });
    f.notify("item/started", { item: command });
    f.notify("item/agentMessage/delta", { itemId: "partial", delta: "Partial response" });
    f.notify("turn/completed", { turn: { id: "turn", status: "interrupted", items: [], error: null } });
    expect(f.state()).toMatchObject({ isStreaming: false, status: "idle", streamingText: "", streamingThinking: "" });
    expect(f.state().lastError).toBeUndefined();
    expect(f.state().messages.some(message => message.role === "assistant" && message.content === "Partial response")).toBe(true);
    expect([...f.state().toolCalls.values()].every(tool => tool.status === "error")).toBe(true);
    expect(f.session()).toMatchObject({ status: "idle", currentTool: null });
    expect(f.events.at(-1)).toMatchObject({ eventType: "agent_end", data: { messages: [{ stopReason: "aborted" }] } });
    const count = f.events.length;
    f.mapper.finishTurn();
    f.notify("turn/completed", { turn: { id: "turn", status: "interrupted", items: [], error: null } });
    expect(f.events).toHaveLength(count);
  });

  it("retry notifications and declined input keep active tool/turn state until native completion", () => {
    const f = fixture();
    f.mapper.beginTurn({ text: "continue" });
    f.notify("item/started", { item: command });
    f.mapper.requestDeclined("item/tool/requestUserInput", "question", { itemId: "cmd", questions: [] });
    expect(f.session()).toMatchObject({ status: "streaming", currentTool: "bash" });
    f.notify("error", { error: { message: "Retrying upstream" }, willRetry: true });
    expect(f.state().isStreaming).toBe(true);
    expect(f.state().lastError).toBeUndefined();
    f.notify("error", { error: { message: "Upstream failed" }, willRetry: false });
    expect(f.state().isStreaming).toBe(false);
    expect(f.state().lastError?.message).toBe("Upstream failed");
  });

  it("final turn payload recovers completed items when individual completion notifications were absent", () => {
    const f = fixture();
    f.mapper.beginTurn({ text: "one response" });
    f.notify("turn/completed", { turn: {
      id: "turn", status: "completed", error: null,
      items: [{ type: "userMessage", id: "user", content: [] }, { type: "agentMessage", id: "answer", text: "Recovered response" }],
    } });
    expect(f.state().messages.map(message => [message.role, message.content])).toEqual([["user", "one response"], ["assistant", "Recovered response"]]);
    expect(f.state().status).toBe("idle");
  });

  it("converts cumulative native usage to noncached-input/cache/output increments without fabricated cost", () => {
    const f = fixture();
    const usage = { total: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 10, totalTokens: 110 }, last: { totalTokens: 110 }, modelContextWindow: 1000 };
    f.mapper.beginTurn({ text: "one" });
    f.notify("thread/tokenUsage/updated", { tokenUsage: usage });
    f.notify("thread/tokenUsage/updated", { tokenUsage: usage });
    expect(f.state()).toMatchObject({ tokensIn: 60, tokensOut: 10, cacheRead: 40, cost: 0, contextUsage: { tokens: 110, contextWindow: 1000 } });
    f.mapper.finishTurn();
    f.mapper.beginTurn({ text: "two" });
    f.notify("thread/tokenUsage/updated", { tokenUsage: { ...usage, total: { inputTokens: 300, cachedInputTokens: 140, outputTokens: 50, totalTokens: 350 }, last: { totalTokens: 240 } } });
    expect(f.state()).toMatchObject({ tokensIn: 160, tokensOut: 50, cacheRead: 140, contextUsage: { tokens: 240, contextWindow: 1000 } });
    expect(extractStatsFromEvents(f.events)).toMatchObject({ tokensIn: 160, tokensOut: 50, cacheRead: 140 });
    for (const event of f.events.filter(event => event.eventType === "stats_update")) expect(event.data).not.toHaveProperty("cost");
  });

  it("resume baselines prevent duplicate totals and stale lower usage cannot reset accounting", () => {
    const f = fixture({ tokensIn: 60, tokensOut: 10, cacheRead: 40 });
    f.mapper.beginTurn({ text: "continue" });
    for (const total of [
      { inputTokens: 100, cachedInputTokens: 40, outputTokens: 10 },
      { inputTokens: 90, cachedInputTokens: 35, outputTokens: 9 },
      { inputTokens: 200, cachedInputTokens: 80, outputTokens: 25 },
    ]) f.notify("thread/tokenUsage/updated", { tokenUsage: { total, last: {}, modelContextWindow: null } });
    expect(f.state()).toMatchObject({ tokensIn: 120, tokensOut: 25, cacheRead: 80 });
    expect(extractStatsFromEvents(f.events)).toMatchObject({ tokensIn: 60, tokensOut: 15, cacheRead: 40 });
  });
});
