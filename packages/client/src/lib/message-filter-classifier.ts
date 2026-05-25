/**
 * Pure-function classifier + filter pass for the 6-category message
 * taxonomy per W3 Q2 recommended-default. Discrimination is based on
 * `ChatMessage.role` + `.skill` + `.toolName` + the embedded
 * `interactiveUi.params.method` payload — never on rendered DOM, never on
 * a network round-trip. The filter pass runs against the post-grouping
 * `ChatItem[]` so collapsed tool-call groups + retried-error badges
 * keep their existing semantics.
 *
 * Cell: pi-agent-dashboard-ux-message-discoverability/v1 (W4.2 Feature 2).
 */

import type { ChatMessage } from "./event-reducer.js";
import type { ChatItem, ToolCallGroup } from "./group-tool-calls.js";
import type { MessageFilter } from "./message-filter-storage.js";
import { DEFAULT_MESSAGE_FILTER } from "./message-filter-storage.js";

export type MessageCategory =
  | "tierA"
  | "tierB"
  | "tierC"
  | "meshChatter"
  | "toolCalls"
  | "systemNotifications";

// System notifications — debug-shaped rows the operator can dim away when
// scanning. `thinking` was previously classified here but is operator-visible
// narrative reasoning content (see fix-thinking-block-streaming-state-loss-
// 2026-05-25 + sister commit 22978a8). Reclassified to `tierB` so committed
// thinking rows render under default filter (which has
// systemNotifications: false but tierB: true).
const SYSTEM_ROLES: ReadonlySet<ChatMessage["role"]> = new Set<ChatMessage["role"]>([
  "turnSeparator",
  "rawEvent",
]);

/** Roles that always classify as tool-calls (UI-side ToolCallStep / BashOutput / CommandFeedback). */
const TOOL_CALL_ROLES: ReadonlySet<ChatMessage["role"]> = new Set<ChatMessage["role"]>([
  "toolResult",
  "bashOutput",
  "commandFeedback",
]);

/**
 * Classify a single ChatMessage or a grouped ToolCallGroup into one of the
 * six categories. Grouped tool-calls always classify as `toolCalls` since
 * groupConsecutiveToolCalls only forms groups from same-tool toolResult
 * rows (see group-tool-calls.ts).
 */
export function classifyMessage(msg: ChatMessage | ToolCallGroup): MessageCategory {
  // Grouped tool calls: always tool-calls category.
  if ((msg as ToolCallGroup).type === "group") return "toolCalls";

  const m = msg as ChatMessage;

  // Tier-A — operator-direct interactive cards (PromptBus / pi-tui asks).
  // Covers ask_user / select / batch / input / confirm / multiselect.
  if (m.role === "interactiveUi") return "tierA";

  // Thinking — model reasoning content; narrative not system-notification.
  // Explicit clause for readability + future-resilience against the
  // defensive default at function-end being changed. See fix-thinking-block-
  // streaming-state-loss-2026-05-25.
  if (m.role === "thinking") return "tierB";

  // System notifications — turnSeparator / raw debug events.
  if (SYSTEM_ROLES.has(m.role)) return "systemNotifications";

  // Tool calls — toolResult / bashOutput / commandFeedback rows.
  // commandFeedback is borderline (it can announce a /-command status,
  // which feels narrative); the W4.2 brief routes it under tool-calls
  // because its render component is the same BashOutput-adjacent surface.
  if (TOOL_CALL_ROLES.has(m.role)) return "toolCalls";

  // Skill invocation on a user message renders as a SkillInvocationCard
  // (substantive content, not chatter). Per W4.2 brief: classify as Tier-B
  // narrative content.
  if (m.role === "user" && m.skill) return "tierB";

  // Plain user / assistant text rows are mesh-chatter (narrative chat the
  // operator can dim away when scanning for asks). Per W4.2 brief: user
  // text without skill envelope + assistant text classify as mesh-chatter.
  if (m.role === "user" || m.role === "assistant") return "meshChatter";

  // Defensive default: anything not enumerated above falls into Tier-B
  // (visible by default) rather than disappearing. New role values added
  // upstream will surface until classifier is updated.
  return "tierB";
}

/**
 * Pre-render filter pass. Returns the subset of items the operator wants
 * to see given the current filter. Pinned entries (Feature 3 sister-coupling)
 * are exempt via `alwaysVisibleEntryIds` — pinned messages always render
 * regardless of category.
 *
 * Composes cleanly with CollapsedToolGroup + RetriedErrorBadge logic in
 * ChatView because filtering happens on the post-grouping ChatItem[] and
 * the renderer's existing visibility checks (hiddenToolResultIds /
 * retriedErrorIds) operate on the still-intact ChatMessage references.
 */
export function filterMessages(
  items: ChatItem[],
  filter: MessageFilter,
  options?: { alwaysVisibleEntryIds?: Set<string> }
): ChatItem[] {
  const alwaysVisible = options?.alwaysVisibleEntryIds;
  return items.filter((item) => {
    // Pinned items (by entryId) are always visible, regardless of category.
    if (alwaysVisible && alwaysVisible.size > 0) {
      if ((item as ToolCallGroup).type === "group") {
        const group = item as ToolCallGroup;
        for (const m of group.messages) {
          if (m.entryId && alwaysVisible.has(m.entryId)) return true;
        }
      } else {
        const m = item as ChatMessage;
        if (m.entryId && alwaysVisible.has(m.entryId)) return true;
      }
    }

    const category = classifyMessage(item);
    return filter[category];
  });
}

/**
 * Diagnostic helper: count messages per-category for the pill counts
 * shown in MessageFilterControls. Counts pre-filter so the operator can
 * see "how many messages would this toggle reveal/hide" before flipping it.
 */
export function countMessagesByCategory(items: ChatItem[]): Record<MessageCategory, number> {
  const counts: Record<MessageCategory, number> = {
    tierA: 0,
    tierB: 0,
    tierC: 0,
    meshChatter: 0,
    toolCalls: 0,
    systemNotifications: 0,
  };
  for (const item of items) {
    counts[classifyMessage(item)]++;
  }
  return counts;
}

/**
 * Convenience: returns true when every category is enabled (equivalent to
 * no-filter, which the renderer can use to skip the filter pass entirely
 * for the common all-on case).
 */
export function isAllOn(filter: MessageFilter): boolean {
  return (
    filter.tierA &&
    filter.tierB &&
    filter.tierC &&
    filter.meshChatter &&
    filter.toolCalls &&
    filter.systemNotifications
  );
}

/** Re-export so consumers only need one import path. */
export { DEFAULT_MESSAGE_FILTER };
export type { MessageFilter };
