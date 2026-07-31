import React from "react";
import { Icon } from "@mdi/react";
import { mdiCheckCircle, mdiFormatListBulleted } from "@mdi/js";
import type { InteractiveRendererProps } from "./types.js";
import { InlineMarkdown } from "./InlineMarkdown.js";
import { CollapsiblePromptBody } from "./CollapsiblePromptBody.js";

/** An option that reads as a cancel/abort choice (e.g. "Cancel", "(3) Cancel + revert …"). */
function isCancelish(option: string): boolean {
  return /\bcancel\b/i.test(option);
}

/** An option whose value IS literally "cancel" — the dismiss shortcut (legacy semantics). */
function isCancelExact(option: string): boolean {
  return /^cancel$/i.test(option.trim());
}

export function SelectRenderer({ params, status, result, onRespond, onCancel }: InteractiveRendererProps) {
  const title = params.title as string;
  const message = params.message as string | undefined;
  const options = (params.options as string[]) ?? [];
  const selectedValue = (result as any)?.value as string | undefined;
  // Compact states summarise with the first line only — the full body can be
  // many lines (e.g. a security capsule); one headline keeps the log scannable.
  const headline = (title ?? "").split("\n")[0];

  if (status !== "pending") {
    return (
      <div className="mx-4 my-1 p-2 bg-[var(--bg-hover)] rounded text-xs flex items-center gap-2">
        <Icon path={mdiFormatListBulleted} size={0.55} className="text-[var(--text-secondary)] shrink-0" />
        <span className="text-[var(--text-secondary)] truncate"><InlineMarkdown content={headline} /></span>
        {status === "resolved" && selectedValue && (
          <span className="ml-1 inline-flex items-center gap-0.5 text-green-400 shrink-0">
            <Icon path={mdiCheckCircle} size={0.55} /> {selectedValue}
          </span>
        )}
        {status === "cancelled" && (
          <span className="ml-1 text-[var(--text-tertiary)] shrink-0">No response</span>
        )}
        {status === "dismissed" && (
          <span className="ml-1 text-[var(--text-tertiary)] shrink-0">Answered in terminal</span>
        )}
      </div>
    );
  }

  // Add a fallback Cancel action only when no option already offers a cancel.
  const hasCancelOption = options.some(isCancelish);

  return (
    <div className="mx-4 my-2 p-3 bg-[var(--bg-hover)] border border-[var(--border-secondary)] rounded-lg">
      {/* Body: decision-first, structure-preserving, collapsible when huge */}
      <div className="flex items-start gap-2 mb-3">
        <Icon path={mdiFormatListBulleted} size={0.6} className="text-blue-400 shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <CollapsiblePromptBody content={title} />
          {message && (
            <div className="text-xs text-[var(--text-secondary)] mt-2">
              <CollapsiblePromptBody content={message} />
            </div>
          )}
        </div>
      </div>

      {/* Options: prominent, tappable, full-width stack — never a cramped side column */}
      <div className="flex flex-col gap-1.5">
        {options.map((option) => {
          const cancelish = isCancelish(option);
          return (
            <button
              key={option}
              onClick={() => (isCancelExact(option) ? onCancel() : onRespond({ value: option }))}
              className={cancelish
                ? "w-full text-left px-3 py-1.5 text-xs rounded bg-transparent hover:bg-[var(--bg-surface)] text-[var(--text-secondary)] border border-[var(--border-secondary)] transition-colors"
                : "w-full text-left px-3 py-1.5 text-xs rounded bg-blue-600 hover:bg-blue-500 text-white font-medium transition-colors"
              }
            >
              {option}
            </button>
          );
        })}
        {!hasCancelOption && (
          <button
            onClick={onCancel}
            className="w-full text-left px-3 py-1.5 text-xs rounded bg-transparent hover:bg-[var(--bg-surface)] text-[var(--text-tertiary)] border border-[var(--border-secondary)] transition-colors"
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
