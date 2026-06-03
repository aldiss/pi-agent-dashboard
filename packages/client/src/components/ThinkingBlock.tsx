import React, { useState } from "react";
import { Icon } from "@mdi/react";
import { mdiChevronRight, mdiChevronDown, mdiHeadLightbulb } from "@mdi/js";
import { MarkdownContent } from "./MarkdownContent.js";
import { ElapsedBadge } from "./ElapsedBadge.js";
import { PinToggleButton } from "./PinToggleButton.js";

/**
 * Pin-context passed from ChatView so each render target can show a
 * pin-toggle in its own header / action bar. The wiring is opt-in:
 * components that don't receive a pinContext render exactly as before.
 * Cell: pi-agent-dashboard-ux-message-discoverability/v1 (W4.3 Feature 3).
 */
export interface PinContext {
  entryId?: string;
  isPinned: boolean;
  onTogglePin: (entryId: string) => void;
}

interface Props {
  content: string;
  isStreaming?: boolean;
  defaultExpanded?: boolean;
  startedAt?: number;
  duration?: number;
  /** Optional Feature 3 pin-context. When set + entryId resolvable, the
   *  ThinkingBlock header renders a pin-toggle button after the elapsed
   *  badge. See W4.3 brief. */
  pinContext?: PinContext;
}

export function ThinkingBlock({ content, isStreaming, defaultExpanded = false, startedAt, duration, pinContext }: Props) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  const showPin = !!pinContext?.entryId && !!pinContext?.onTogglePin;

  return (
    <div
      className="mx-4 border-l-2 border-purple-500/30 pl-3"
      {...(pinContext?.entryId ? { "data-entry-id": pinContext.entryId } : {})}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-xs text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] w-full text-left"
      >
        <span className="inline-flex text-purple-400">
          <Icon path={mdiHeadLightbulb} size={0.55} />
        </span>
        <span className="truncate">
          Reasoning
          {isStreaming && <span className="ml-1 animate-pulse">…</span>}
        </span>
        <ElapsedBadge startedAt={startedAt} duration={duration} />
        {showPin && (
          <span className="ml-1 inline-flex">
            <PinToggleButton
              entryId={pinContext!.entryId!}
              isPinned={pinContext!.isPinned}
              onToggle={pinContext!.onTogglePin}
              size={0.5}
              dimWhenNotPinned
            />
          </span>
        )}
        <span className="ml-auto text-[var(--text-muted)] inline-flex">
          <Icon path={expanded ? mdiChevronDown : mdiChevronRight} size={0.6} />
        </span>
      </button>
      {expanded && (
        <div className="mt-1 ml-4 p-2 bg-purple-500/5 rounded-xl shadow-md border border-purple-500/10 text-xs text-[var(--text-secondary)] overflow-x-auto max-h-[400px] overflow-y-auto">
          <MarkdownContent content={content} />
          {isStreaming && (
            <span className="inline-block w-1.5 h-3 bg-purple-400/50 animate-pulse ml-0.5" />
          )}
        </div>
      )}
    </div>
  );
}
