/**
 * MessageFilterControls — controlled-component pill row for the 6-category
 * message-type filter. ChatView owns canonical filter state + persists via
 * setMessageFilter; this component is render + click-dispatch only.
 *
 * Visual taxonomy per W3 Q2 recommended-default:
 *   - Questions         — emphasized chip (highlighted when active)
 *   - Narrative         — normal conversation
 *   - Background events — rare internal-only row (DEFAULT OFF; muted)
 *   - Agent-only chat   — dimmed chip
 *   - Tool calls        — collapsible chip (DEFAULT OFF)
 *   - System notes      — debug / thinking / separator (DEFAULT OFF)
 *
 * Cell: pi-agent-dashboard-ux-message-discoverability/v1 (W4.2 Feature 2).
 */

import React from "react";
import type { MessageFilter } from "../lib/message-filter-storage.js";
import { DEFAULT_MESSAGE_FILTER, isDefaultMessageFilter } from "../lib/message-filter-storage.js";
import type { MessageCategory } from "../lib/message-filter-classifier.js";

interface Props {
  sessionId: string;
  filter: MessageFilter;
  onFilterChange: (next: MessageFilter) => void;
  /** Per-category message counts (pre-filter). Drives the chip label suffix. */
  counts?: Record<MessageCategory, number>;
  /** When set, parent owns the open/close gate; the controls render inline. */
  onClose?: () => void;
}

interface CategoryMeta {
  key: MessageCategory;
  label: string;
  description: string;
  /** Tailwind classes for the chip when the category is ON. */
  onClass: string;
  /** Tailwind classes for the chip when the category is OFF. */
  offClass: string;
}

const CATEGORIES: CategoryMeta[] = [
  {
    key: "tierA",
    label: "Questions",
    description: "Questions and choices sent directly to the operator",
    onClass: "bg-amber-500/15 border-amber-500/40 text-amber-300",
    offClass: "border-amber-500/20 text-amber-400/60",
  },
  {
    key: "tierB",
    label: "Narrative",
    description: "User + assistant content, skill invocations",
    onClass: "bg-blue-500/15 border-blue-500/40 text-blue-300",
    offClass: "border-blue-500/20 text-blue-400/60",
  },
  {
    key: "meshChatter",
    label: "Agent-only chat",
    description: "Messages explicitly addressed to another agent",
    onClass: "bg-slate-400/15 border-slate-400/40 text-slate-200",
    offClass: "border-slate-400/20 text-slate-400/60",
  },
  {
    key: "toolCalls",
    label: "Tool calls",
    description: "Tool results, bash output, command feedback",
    onClass: "bg-emerald-500/15 border-emerald-500/40 text-emerald-300",
    offClass: "border-emerald-500/20 text-emerald-400/60",
  },
  {
    key: "systemNotifications",
    label: "System notes",
    description: "Thinking, turn separators, raw debug events",
    onClass: "bg-purple-500/15 border-purple-500/40 text-purple-300",
    offClass: "border-purple-500/20 text-purple-400/60",
  },
  {
    key: "tierC",
    label: "Background events",
    description: "Rare internal activity rows",
    onClass: "bg-rose-500/15 border-rose-500/40 text-rose-300",
    offClass: "border-rose-500/20 text-rose-400/60",
  },
];

export function MessageFilterControls({ sessionId: _sessionId, filter, onFilterChange, counts, onClose }: Props) {
  const handleToggle = (key: MessageCategory) => {
    onFilterChange({ ...filter, [key]: !filter[key] });
  };

  const handleReset = () => {
    onFilterChange({ ...DEFAULT_MESSAGE_FILTER });
  };

  const isDefault = isDefaultMessageFilter(filter);

  return (
    <div
      className="px-3 py-2 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)] flex items-center gap-2 flex-wrap"
      data-testid="message-filter-controls"
    >
      <span className="text-[10px] uppercase tracking-wide text-[var(--text-tertiary)] mr-1">
        Filter:
      </span>
      {CATEGORIES.map((cat) => {
        const active = filter[cat.key];
        const count = counts ? counts[cat.key] : undefined;
        return (
          <button
            key={cat.key}
            type="button"
            onClick={() => handleToggle(cat.key)}
            title={cat.description}
            aria-pressed={active}
            data-testid={`message-filter-pill-${cat.key}`}
            className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${active ? cat.onClass : cat.offClass} hover:brightness-110`}
          >
            <span className="inline-block w-1.5 h-1.5 rounded-full mr-1 align-middle"
                  style={{ backgroundColor: active ? "currentColor" : "transparent", border: active ? "none" : "1px solid currentColor" }} />
            {cat.label}
            {typeof count === "number" && (
              <span className="ml-1 opacity-70">({count})</span>
            )}
          </button>
        );
      })}
      <span className="flex-1" />
      {!isDefault && (
        <button
          type="button"
          onClick={handleReset}
          className="text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] underline"
          data-testid="message-filter-reset"
        >
          Reset filters
        </button>
      )}
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text-secondary)] px-1"
          title="Hide filter controls"
        >
          ✕
        </button>
      )}
    </div>
  );
}
