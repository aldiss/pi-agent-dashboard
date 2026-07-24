const OPERATOR_PROSE_TOOLS = new Set(["ask_user", "push_notify_user"]);

const OPERATOR_PROSE_TOOL_LABELS: Readonly<Record<string, string>> = {
  ask_user: "Question",
  push_notify_user: "Device notification",
};

export function isOperatorProseTool(toolName: unknown): boolean {
  return typeof toolName === "string" && OPERATOR_PROSE_TOOLS.has(toolName.toLowerCase());
}

/** Fixed operator-facing label; internal tool identifiers never become chrome. */
export function operatorProseToolLabel(toolName: unknown): string | undefined {
  if (typeof toolName !== "string") return undefined;
  return OPERATOR_PROSE_TOOL_LABELS[toolName.toLowerCase()];
}

/** Deny raw operator prose; ask method is the sole non-prose display field. */
export function sanitizeOperatorProseToolArgs(
  toolName: unknown,
  args: unknown,
): Record<string, unknown> | undefined {
  if (!isOperatorProseTool(toolName)) {
    return args && typeof args === "object" && !Array.isArray(args)
      ? args as Record<string, unknown>
      : undefined;
  }
  if (String(toolName).toLowerCase() !== "ask_user") return undefined;
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const method = (args as Record<string, unknown>).method;
  return typeof method === "string" ? { method } : undefined;
}

/**
 * Clone a protected lifecycle event into its status-only wire form. The input
 * object and its core-owned arguments are never mutated.
 */
export function sanitizeOperatorProseToolWireEvent(
  eventType: string,
  event: Record<string, unknown>,
): Record<string, unknown> {
  if (!isOperatorProseTool(event.toolName)) return event;
  const base: Record<string, unknown> = {
    type: event.type,
    toolCallId: event.toolCallId,
    toolName: event.toolName,
  };
  if (eventType === "tool_execution_start") {
    return { ...base, args: sanitizeOperatorProseToolArgs(event.toolName, event.args) };
  }
  if (eventType === "tool_call") {
    return { ...base, input: sanitizeOperatorProseToolArgs(event.toolName, event.input) };
  }
  if (eventType === "tool_result") {
    return { ...base, isError: event.isError === true };
  }
  if (eventType === "tool_execution_update") return base;
  if (eventType === "tool_execution_end") {
    return { ...base, isError: event.isError === true };
  }
  return event;
}
