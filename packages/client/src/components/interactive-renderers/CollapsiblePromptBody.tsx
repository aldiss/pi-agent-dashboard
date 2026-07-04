import React, { useState } from "react";
import { Icon } from "@mdi/react";
import { mdiChevronDown, mdiChevronUp } from "@mdi/js";
import { MarkdownContent } from "../MarkdownContent.js";

/**
 * Renders a prompt body (markdown) that stays scannable even when a capsule is
 * huge: content beyond a budget is clamped behind a "Show more" affordance so a
 * 300-line command / heredoc body can never flood the card. Structure-preserving
 * (block markdown + fenced code) — unlike InlineMarkdown, which collapses newlines
 * into one run and produced the original wall-of-text.
 *
 * Collapse is decided by a cheap, deterministic content heuristic (char + line
 * count) rather than layout measurement, so it behaves identically in tests and
 * in the browser and never depends on ResizeObserver.
 */
export function CollapsiblePromptBody({
  content,
  collapsedMaxPx = 200,
}: {
  content: string;
  collapsedMaxPx?: number;
}) {
  const [expanded, setExpanded] = useState(false);

  const lineCount = content.split("\n").length;
  const isLong = content.length > 300 || lineCount > 8;
  const collapsed = isLong && !expanded;

  return (
    <div>
      <div
        className="relative overflow-hidden text-xs text-[var(--text-primary)] break-words"
        style={collapsed ? { maxHeight: collapsedMaxPx } : undefined}
        data-testid="prompt-body"
        data-collapsed={collapsed ? "true" : "false"}
      >
        <MarkdownContent content={content} />
        {collapsed && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-[var(--bg-hover)] to-transparent" />
        )}
      </div>
      {isLong && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-blue-400 hover:text-blue-300 hover:underline"
          aria-expanded={expanded}
          data-testid="prompt-body-toggle"
        >
          <Icon path={expanded ? mdiChevronUp : mdiChevronDown} size={0.55} />
          {expanded ? "Show less" : "Show full command"}
        </button>
      )}
    </div>
  );
}
