/**
 * "Pinned messages" section rendered at the top of the ChatView scroll
 * container (scrolls WITH messages, NOT sticky — sister-shape to existing
 * banners). Empty state returns null so the section stays invisible when no
 * pins exist; never renders an empty header.
 *
 * Per W4.3 brief: each pinned-message row is a preview (NOT a full
 * re-render of the original MessageBubble / ToolCallStep) showing role
 * indicator + content preview truncated to ~100 chars + unpin button. Click
 * scrolls the main message stream to the inline-rendered original (which
 * keeps its own pin-icon indicator). This avoids duplicate rendering of
 * heavy markdown content / tool-call expansions / streaming state.
 *
 * Pins appear in original-message-order (not pin-creation-order) so context
 * is preserved when the operator opens the section: it reads top-to-bottom
 * along the session timeline, matching how MarkdownSearch hits are ordered.
 *
 * Cell: pi-agent-dashboard-ux-message-discoverability/v1 (W4.3 Feature 3).
 */

import React, { useMemo, useState } from "react";
import { Icon } from "@mdi/react";
import { mdiPin, mdiPinOff, mdiChevronRight, mdiChevronDown, mdiClose } from "@mdi/js";
import type { ChatMessage } from "../lib/event-reducer.js";

interface Props {
  sessionId: string;
  /** All session entries (pre-filter, pre-grouping). The section iterates
   *  in entries-order so pinned items appear top-to-bottom matching the
   *  session timeline, regardless of pin-creation order. */
  entries: ChatMessage[];
  /** Set of pinned entryIds (canonical state held in ChatView). */
  pinnedEntryIds: Set<string>;
  /** Called when "Unpin all" is clicked. */
  onUnpinAll: () => void;
  /** Called with the entryId of the pinned-message preview the operator
   *  clicked; ChatView scrolls the main stream to that message and flashes
   *  the row briefly per .pinned-message-flash discipline. */
  onScrollToMessage: (entryId: string) => void;
  /** Called when the operator unpins a single message via the row's
   *  inline unpin button. ChatView updates pinnedEntryIds + persists. */
  onTogglePin: (entryId: string) => void;
}

/** Auto-collapse heuristic per W4.3 brief: ≤5 pins → expanded; >5 → collapsed.
 *  Operator can override either way via the chevron toggle. */
const AUTO_COLLAPSE_THRESHOLD = 5;

/** Preview-text truncation per W4.3 brief (~100 chars). */
const PREVIEW_MAX_CHARS = 100;

function roleIndicator(msg: ChatMessage): { label: string; colorClass: string } {
  switch (msg.role) {
    case "user":
      return msg.skill
        ? { label: "skill", colorClass: "text-purple-400" }
        : { label: "you", colorClass: "text-blue-400" };
    case "assistant":
      return { label: "assistant", colorClass: "text-emerald-400" };
    case "thinking":
      return { label: "thinking", colorClass: "text-purple-300" };
    case "toolResult":
      return {
        label: msg.toolName ? `tool: ${msg.toolName}` : "tool",
        colorClass: "text-amber-400",
      };
    case "bashOutput":
      return { label: "bash", colorClass: "text-amber-300" };
    case "commandFeedback":
      return { label: "/cmd", colorClass: "text-cyan-400" };
    case "interactiveUi":
      return { label: "ask", colorClass: "text-sky-400" };
    case "rawEvent":
      return {
        label: msg.toolName ? `raw: ${msg.toolName}` : "raw",
        colorClass: "text-zinc-400",
      };
    case "turnSeparator":
      return { label: "turn", colorClass: "text-zinc-400" };
    default:
      return { label: "msg", colorClass: "text-[var(--text-secondary)]" };
  }
}

function previewText(msg: ChatMessage): string {
  // Choose the most informative single string for the preview. For
  // tool-calls we prefer the friendly toolName + args summary if content
  // is empty; for plain text we use content directly. Newlines flatten
  // to spaces so the preview stays single-line.
  let src = msg.content;
  if (!src && msg.role === "toolResult") {
    src = msg.toolName ?? "tool call";
  }
  if (!src) src = "(empty)";
  const flat = src.replace(/\s+/g, " ").trim();
  if (flat.length <= PREVIEW_MAX_CHARS) return flat;
  return flat.slice(0, PREVIEW_MAX_CHARS - 1).trimEnd() + "…";
}

export function PinnedMessagesSection({
  sessionId,
  entries,
  pinnedEntryIds,
  onUnpinAll,
  onScrollToMessage,
  onTogglePin,
}: Props) {
  // Pinned entries in original-message-order: walk entries[], keep those
  // whose entryId is in pinnedEntryIds. Stale pins (entries no longer in
  // the buffer because they evicted from the in-memory ring) are silently
  // skipped — the pin persists in localStorage and re-renders if the
  // entry reloads later.
  const pinnedMessages = useMemo(() => {
    if (pinnedEntryIds.size === 0) return [] as ChatMessage[];
    return entries.filter((m) => m.entryId && pinnedEntryIds.has(m.entryId));
  }, [entries, pinnedEntryIds]);

  const initialCollapsed = pinnedEntryIds.size > AUTO_COLLAPSE_THRESHOLD;
  const [collapsed, setCollapsed] = useState<boolean>(initialCollapsed);
  // Reset collapsed state when the session changes (so opening a different
  // session reapplies the auto-collapse heuristic against its own count).
  React.useEffect(() => {
    setCollapsed(pinnedEntryIds.size > AUTO_COLLAPSE_THRESHOLD);
  }, [sessionId, pinnedEntryIds.size]);

  // Empty-state guard: when nothing is pinned (or every pin is currently
  // stale / not in entries), render nothing. The section never occupies
  // header space unless there's something to show.
  if (pinnedMessages.length === 0) {
    return null;
  }

  const count = pinnedMessages.length;

  return (
    <div
      className="mx-2 mt-2 mb-1 rounded-xl border border-amber-500/30 bg-amber-500/5 text-xs"
      data-testid="pinned-messages-section"
    >
      {/* Header row — chevron toggle + count + unpin-all action */}
      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-amber-500/20">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="flex items-center gap-1 text-amber-300 hover:text-amber-200 min-w-0 flex-1 text-left"
          title={collapsed ? "Expand pinned messages" : "Collapse pinned messages"}
          data-testid="pinned-messages-toggle"
        >
          <Icon path={collapsed ? mdiChevronRight : mdiChevronDown} size={0.55} />
          <Icon path={mdiPin} size={0.5} className="text-amber-400" />
          <span className="font-medium">Pinned messages ({count})</span>
        </button>
        <button
          type="button"
          onClick={onUnpinAll}
          className="px-1.5 py-0.5 rounded text-amber-400/80 hover:text-amber-200 hover:bg-amber-500/10 inline-flex items-center gap-0.5 text-[10px]"
          title="Unpin all messages"
          data-testid="pinned-messages-unpin-all"
        >
          <Icon path={mdiPinOff} size={0.45} />
          <span>Unpin all</span>
        </button>
      </div>

      {/* Body: per-pin preview rows. Collapsed: hidden. */}
      {!collapsed && (
        <ul className="px-1.5 py-1 space-y-0.5">
          {pinnedMessages.map((msg) => {
            const role = roleIndicator(msg);
            const preview = previewText(msg);
            const entryId = msg.entryId!; // filter guarantees presence
            return (
              <li
                key={`pinned-${entryId}`}
                className="flex items-start gap-2 px-2 py-1 rounded hover:bg-amber-500/10 group"
                data-testid="pinned-message-row"
                data-pinned-entry-id={entryId}
              >
                <button
                  type="button"
                  onClick={() => onScrollToMessage(entryId)}
                  className="flex-1 min-w-0 text-left flex items-start gap-2"
                  title="Scroll to this message"
                  data-testid="pinned-message-jump"
                >
                  <span className={`shrink-0 font-medium ${role.colorClass}`}>
                    {role.label}
                  </span>
                  <span className="flex-1 min-w-0 text-[var(--text-secondary)] truncate">
                    {preview}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onTogglePin(entryId);
                  }}
                  className="shrink-0 p-0.5 rounded opacity-50 group-hover:opacity-100 text-amber-400/80 hover:text-red-400 hover:bg-amber-500/10 transition-opacity"
                  title="Unpin this message"
                  aria-label="Unpin this message"
                  data-testid="pinned-message-unpin"
                >
                  <Icon path={mdiClose} size={0.5} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
