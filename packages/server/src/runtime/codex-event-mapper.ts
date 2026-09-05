import { randomUUID } from "node:crypto";
import type { RuntimeEvent, RuntimeSendInput } from "./types.js";

interface MappedItem {
  id: string;
  native: any;
  kind: "assistant" | "reasoning" | "tool";
  text: string;
  committed: string;
  sent: string;
  summary: string[];
  content: string[];
  started: boolean;
  closed: boolean;
}

function textOf(value: any): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).join("\n");
  if (typeof value.text === "string") return value.text;
  if (value.type === "inputImage") return "[Image output]";
  return JSON.stringify(value, null, 2);
}

function toolShape(item: any): { toolName: string; args: Record<string, unknown> } {
  switch (item.type) {
    case "commandExecution": return { toolName: "bash", args: { command: item.command ?? "", cwd: item.cwd } };
    case "fileChange": return { toolName: "edit", args: { path: item.changes?.[0]?.path, changes: item.changes ?? [] } };
    case "mcpToolCall": return { toolName: `${item.server}/${item.tool}`, args: item.arguments ?? {} };
    case "dynamicToolCall": return { toolName: item.tool ?? "dynamic_tool", args: item.arguments ?? {} };
    default: return { toolName: `codex_${item.type ?? "item"}`, args: item };
  }
}

function toolResult(item: any, partial: string): string {
  if (item.error) return textOf(item.error.message ?? item.error);
  switch (item.type) {
    case "commandExecution": return item.aggregatedOutput ?? partial;
    case "fileChange": return (item.changes ?? []).map((change: any) => `${change.path}\n${change.diff ?? ""}`).join("\n\n") || partial;
    case "mcpToolCall": return textOf(item.result?.content) || textOf(item.result?.structuredContent) || partial;
    case "dynamicToolCall": return textOf(item.contentItems) || partial;
    default: return textOf(item);
  }
}

export function createCodexEventMapper(options: {
  emit(event: RuntimeEvent): void;
  initialStats?: { tokensIn?: number; tokensOut?: number; cacheRead?: number };
}) {
  let active = false;
  let turnKey = randomUUID();
  let assistant: MappedItem | undefined;
  let thinking: MappedItem | undefined;
  const items = new Map<string, MappedItem>();
  const declined = new Set<string>();
  let totals = { tokensIn: options.initialStats?.tokensIn ?? 0, tokensOut: options.initialStats?.tokensOut ?? 0, cacheRead: options.initialStats?.cacheRead ?? 0 };
  let context: { tokens: number | null; contextWindow: number } | undefined;
  const emit = (eventType: string, data: any) => options.emit({ eventType, data, timestamp: Date.now() });
  const toolId = (item: MappedItem) => `codex-${turnKey}-${item.id}`;
  const remaining = (item: MappedItem) => item.text.startsWith(item.committed) ? item.text.slice(item.committed.length) : item.text;
  const message = (item: MappedItem) => ({ role: "assistant", content: [{ type: "text", text: remaining(item) }] });

  function activateAssistant(item: MappedItem) {
    if (assistant === item) return;
    if (assistant) finishAssistant(assistant, false);
    assistant = item;
    emit("message_start", { message: { role: "assistant", content: [] } });
  }

  function finishAssistant(item: MappedItem, completed = true) {
    if (item.closed) return;
    if (assistant === item || remaining(item)) {
      activateAssistant(item);
      // message_end consumes streamingText preferentially, so update final text first.
      emit("message_update", { message: message(item) });
      emit("message_end", { message: message(item), nonce: toolId(item) });
      assistant = undefined;
      item.committed = item.text;
    }
    item.closed = completed;
  }

  function syncThinking(item: MappedItem) {
    item.text = (item.summary.some(Boolean) ? item.summary : item.content).join("\n\n");
    if (thinking !== item) {
      if (thinking) finishThinking(thinking, false);
      thinking = item;
      item.sent = "";
      emit("message_update", { assistantMessageEvent: { type: "thinking_start" } });
    }
    const next = remaining(item);
    if (!next.startsWith(item.sent)) {
      emit("message_update", { assistantMessageEvent: { type: "thinking_start" } });
      item.sent = "";
    }
    if (next !== item.sent) emit("message_update", { assistantMessageEvent: { type: "thinking_delta", delta: next.slice(item.sent.length) } });
    item.sent = next;
  }

  function finishThinking(item: MappedItem, completed = true) {
    if (item.closed) return;
    item.text = (item.summary.some(Boolean) ? item.summary : item.content).join("\n\n");
    if (thinking === item || remaining(item)) {
      syncThinking(item);
      emit("message_update", { assistantMessageEvent: { type: "thinking_end" } });
      thinking = undefined;
      item.committed = item.text;
      item.sent = "";
    }
    item.closed = completed;
  }

  function restoreCurrentTool() {
    const open = [...items.values()].findLast(item => item.kind === "tool" && !item.closed);
    if (open) emit("tool_execution_start", { toolCallId: toolId(open), ...toolShape(open.native) });
  }

  function startItem(native: any, started = false): MappedItem | undefined {
    if (!native || typeof native.id !== "string" || native.type === "userMessage") return;
    const previous = items.get(native.id);
    if (previous) { previous.native = { ...previous.native, ...native }; previous.started ||= started; return previous; }
    const kind = native.type === "agentMessage" ? "assistant" : native.type === "reasoning" ? "reasoning" : "tool";
    const item: MappedItem = {
      id: native.id, native, kind, text: typeof native.text === "string" ? native.text : "", committed: "", sent: "",
      summary: [...(native.summary ?? [])], content: kind === "reasoning" ? [...(native.content ?? [])] : [], started, closed: false,
    };
    items.set(native.id, item);
    if (kind === "assistant") {
      activateAssistant(item);
      if (item.text) emit("message_update", { message: message(item) });
    } else if (kind === "reasoning") {
      if (assistant) finishAssistant(assistant, false);
      syncThinking(item);
    } else {
      // Commit prose/thinking before the tool; otherwise reducer's flush hides later deltas.
      if (assistant) finishAssistant(assistant, false);
      if (thinking) finishThinking(thinking, false);
      emit("tool_execution_start", { toolCallId: toolId(item), ...toolShape(native) });
    }
    return item;
  }

  function finishTool(item: MappedItem, error?: string) {
    if (item.closed) return;
    const native = item.native;
    const isError = !!error || !!native.error || native.success === false
      || native.status === "failed" || native.status === "declined"
      || (typeof native.exitCode === "number" && native.exitCode !== 0);
    const output = toolResult(native, item.text);
    emit("tool_execution_end", {
      toolCallId: toolId(item), toolName: toolShape(native).toolName, isError,
      result: error ? [output, error].filter(Boolean).join("\n") : output || (isError ? `Tool ${native.status ?? "failed"}` : "Completed"),
    });
    item.closed = true;
    restoreCurrentTool();
  }

  function completeItem(native: any) {
    if (native?.type === "agentMessage" && typeof native.id === "string" && !items.has(native.id)) {
      // Native completion can replace the streamed ID. Adopt only one explicit
      // open lifecycle in the same phase; never infer identity from text.
      const pending = [...items.values()].filter(item => item.kind === "assistant" && item.started && !item.closed);
      if (pending.length === 1 && (pending[0].native.phase ?? null) === (native.phase ?? null)) items.set(native.id, pending[0]);
    }
    const item = startItem(native);
    if (!item || item.closed) return;
    if (item.kind === "assistant") {
      if (typeof native.text === "string") item.text = native.text;
      finishAssistant(item);
    } else if (item.kind === "reasoning") {
      if (Array.isArray(native.summary)) item.summary = [...native.summary];
      if (Array.isArray(native.content)) item.content = [...native.content];
      finishThinking(item);
    } else finishTool(item);
  }

  function finishTurn(error?: string, interrupted = false) {
    if (!active) return;
    for (const item of items.values()) {
      if (item.kind === "assistant") finishAssistant(item);
      else if (item.kind === "reasoning") finishThinking(item);
      else if (!item.closed) finishTool(item, error ?? (interrupted ? "Turn interrupted" : "Turn ended before tool completed"));
    }
    active = false;
    emit("agent_end", error ? { error, messages: [{ role: "assistant", stopReason: "error", errorMessage: error }] }
      : { messages: interrupted ? [{ role: "assistant", stopReason: "aborted" }] : [] });
  }

  function updateUsage(usage: any) {
    const total = usage?.total;
    if (!total || ![total.inputTokens, total.cachedInputTokens, total.outputTokens].every(value => typeof value === "number" && Number.isFinite(value) && value >= 0)) return;
    const next = { tokensIn: Math.max(0, total.inputTokens - total.cachedInputTokens), tokensOut: total.outputTokens, cacheRead: total.cachedInputTokens };
    if (next.tokensIn < totals.tokensIn || next.tokensOut < totals.tokensOut || next.cacheRead < totals.cacheRead) return;
    const delta = { tokensIn: next.tokensIn - totals.tokensIn, tokensOut: next.tokensOut - totals.tokensOut, cacheRead: next.cacheRead - totals.cacheRead };
    const nextContext = typeof usage.modelContextWindow === "number" && usage.modelContextWindow > 0
      ? { tokens: typeof usage.last?.totalTokens === "number" ? usage.last.totalTokens : null, contextWindow: usage.modelContextWindow } : undefined;
    const changed = delta.tokensIn > 0 || delta.tokensOut > 0 || delta.cacheRead > 0;
    const contextChanged = !!nextContext && (nextContext.tokens !== context?.tokens || nextContext.contextWindow !== context?.contextWindow);
    if (!changed && !contextChanged) return;
    totals = next;
    if (nextContext) context = nextContext;
    emit("stats_update", {
      ...(changed ? { tokensIn: delta.tokensIn, tokensOut: delta.tokensOut, turnUsage: { input: delta.tokensIn, output: delta.tokensOut, cacheRead: delta.cacheRead, cacheWrite: 0 } } : {}),
      ...(nextContext ? { contextUsage: nextContext } : {}),
    });
  }

  return {
    beginTurn(input: RuntimeSendInput): void {
      if (active) throw new Error("Codex turn already active");
      active = true;
      turnKey = randomUUID();
      items.clear(); declined.clear(); assistant = undefined; thinking = undefined;
      const data = {
        message: { role: "user", content: [{ type: "text", text: input.text }, ...(input.images ?? [])] }, nonce: turnKey,
        ...(input.author ? { author: input.author } : {}), ...(input.queueNonce ? { queueNonce: input.queueNonce } : {}),
      };
      emit("agent_start", {});
      emit("message_start", data);
      emit("message_end", data);
    },
    handleNotification(method: string, params: any): void {
      if (method === "thread/tokenUsage/updated") { updateUsage(params?.tokenUsage); return; }
      if (!active || !params) return;
      if (method === "item/started") { startItem(params.item, true); return; }
      if (method === "item/completed") { completeItem(params.item); return; }
      if (method === "item/agentMessage/delta") {
        const item = startItem({ type: "agentMessage", id: params.itemId });
        if (item && !item.closed && typeof params.delta === "string") {
          item.text += params.delta;
          activateAssistant(item);
          emit("message_update", { message: message(item) });
        }
      } else if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta" || method === "item/reasoning/summaryPartAdded") {
        const item = startItem({ type: "reasoning", id: params.itemId });
        if (!item || item.closed) return;
        const summary = method !== "item/reasoning/textDelta";
        const parts = summary ? item.summary : item.content;
        const index = (summary ? params.summaryIndex : params.contentIndex) ?? 0;
        if (!Number.isInteger(index) || index < 0) return;
        parts[index] = (parts[index] ?? "") + (typeof params.delta === "string" ? params.delta : "");
        syncThinking(item);
      } else if (method === "item/commandExecution/outputDelta" || method === "item/fileChange/outputDelta" || method === "item/mcpToolCall/progress" || method === "item/fileChange/patchUpdated") {
        const item = items.get(params.itemId);
        if (!item || item.closed) return;
        if (method === "item/fileChange/patchUpdated") {
          item.native.changes = params.changes;
          item.text = toolResult(item.native, item.text);
        } else item.text += typeof params.delta === "string" ? params.delta : `${params.message ?? ""}\n`;
        emit("tool_execution_update", { toolCallId: toolId(item), partialResult: item.text });
      } else if (method === "turn/completed") {
        for (const item of params.turn?.items ?? []) {
          if (item.status === "inProgress") startItem(item);
          else completeItem(item);
        }
        const error = params.turn?.error?.message ?? (params.turn?.status === "failed" ? "Codex turn failed" : undefined);
        finishTurn(error, params.turn?.status === "interrupted");
      } else if (method === "error") {
        if (params.willRetry) emit("command_feedback", { command: "codex", status: "error", message: params.error?.message ?? "Codex is retrying" });
        else finishTurn(params.error?.message ?? "Codex turn failed");
      }
    },
    finishTurn,
    requestDeclined(method: string, id: string | number, _params: any): void {
      const key = `${typeof id}:${id}`;
      if (declined.has(key)) return;
      declined.add(key);
      if (assistant) finishAssistant(assistant, false);
      const toolCallId = `codex-${turnKey}-request-${key}`;
      emit("tool_execution_start", { toolCallId, toolName: "codex_request", args: { method, requestId: id } });
      emit("tool_execution_end", { toolCallId, toolName: "codex_request", isError: true, result: `Request declined: ${method}` });
      restoreCurrentTool();
    },
  };
}

export type CodexEventMapper = ReturnType<typeof createCodexEventMapper>;
