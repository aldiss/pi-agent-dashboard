import {
  isOperatorProseTool,
  sanitizeOperatorProseToolWireEvent,
} from "@blackbelt-technology/pi-dashboard-shared/operator-tool-visibility.js";
import {
  withoutOperatorProseToolPayloads,
} from "@blackbelt-technology/pi-dashboard-shared/state-replay.js";

/**
 * Correlates protected tool lifecycle frames whose update/end events omit the
 * tool name. Only the cloned wire frame is enriched and sanitized; core-owned
 * event objects remain untouched.
 */
export class OperatorToolWireTracker {
  private readonly protectedNamesById = new Map<string, string>();

  private remember(toolCallId: string, toolName: string): void {
    this.protectedNamesById.set(toolCallId, toolName);
  }

  sanitize(eventType: string, event: Record<string, unknown>): Record<string, unknown> {
    const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
    if (eventType === "tool_execution_start" && toolCallId) {
      if (typeof event.toolName === "string" && isOperatorProseTool(event.toolName)) {
        this.remember(toolCallId, event.toolName);
      } else {
        this.protectedNamesById.delete(toolCallId);
      }
    }

    const knownName = toolCallId ? this.protectedNamesById.get(toolCallId) : undefined;
    const eventWithKnownName = knownName && !isOperatorProseTool(event.toolName)
      ? { ...event, toolName: knownName }
      : event;
    const wire = sanitizeOperatorProseToolWireEvent(eventType, eventWithKnownName);

    return wire;
  }

  sanitizeMessage<T>(message: T): T {
    if (!message || typeof message !== "object" || Array.isArray(message)) return message;
    const record = message as Record<string, unknown>;
    if (record.role === "assistant" && Array.isArray(record.content)) {
      for (const part of record.content) {
        if (!part || typeof part !== "object" || Array.isArray(part)) continue;
        const block = part as Record<string, unknown>;
        if (block.type === "toolCall" && typeof block.id === "string" &&
            typeof block.name === "string" && isOperatorProseTool(block.name)) {
          this.remember(block.id, block.name);
        }
      }
    }

    if (record.role === "toolResult" && typeof record.toolCallId === "string") {
      const knownName = this.protectedNamesById.get(record.toolCallId);
      if (knownName && !isOperatorProseTool(record.toolName)) {
        return withoutOperatorProseToolPayloads({
          ...record,
          toolName: knownName,
        }) as T;
      }
    }
    return withoutOperatorProseToolPayloads(message);
  }

  clear(): void {
    this.protectedNamesById.clear();
  }
}
