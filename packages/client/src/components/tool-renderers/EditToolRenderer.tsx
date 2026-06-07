import React, { Suspense } from "react";
import { createTwoFilesPatch } from "diff";
import type { ToolRendererProps } from "./types.js";
import { OpenFileButton } from "./OpenFileButton.js";
import { useMobile } from "../../hooks/useMobile.js";
// RichDiff pulls in the @git-diff-view rich-diff graph (~1.1MB decoded). It is
// only rendered inline for the DESKTOP edit-diff path (mobile uses the cheap
// jsdiff <DiffView> below), so React.lazy keeps @git-diff-view out of the eager
// home bundle. See change: lazy-split-heavy-client-chunks.
const RichDiff = React.lazy(() =>
  import("../RichDiff.js").then((m) => ({ default: m.RichDiff })),
);

function LazyRichDiff(props: { oldText: string; newText: string; filePath: string; maxHeight?: string }) {
  return (
    <Suspense
      fallback={
        <div className="px-2 py-3 text-xs text-[var(--text-muted)] italic">Loading diff…</div>
      }
    >
      <RichDiff {...props} />
    </Suspense>
  );
}

function DiffView({ oldText, newText, filePath }: { oldText: string; newText: string; filePath: string }) {
  const patch = createTwoFilesPatch(filePath, filePath, oldText, newText, "before", "after", { context: 3 });
  const lines = patch.split("\n");

  return (
    <div className="font-mono text-xs leading-relaxed overflow-auto max-h-80">
      {lines.map((line, i) => {
        let className = "text-[var(--text-tertiary)] px-2"; // default (header lines)
        if (line.startsWith("+++") || line.startsWith("---")) {
          className = "text-[var(--text-tertiary)] px-2 font-bold";
        } else if (line.startsWith("@@")) {
          className = "text-[var(--accent-blue)] px-2 bg-[color-mix(in_srgb,var(--accent-blue)_15%,transparent)]";
        } else if (line.startsWith("+")) {
          className = "text-[var(--accent-green)] px-2 bg-[color-mix(in_srgb,var(--accent-green)_15%,transparent)]";
        } else if (line.startsWith("-")) {
          className = "text-[var(--accent-red)] px-2 bg-[color-mix(in_srgb,var(--accent-red)_15%,transparent)]";
        }
        return (
          <div key={i} className={className}>
            {line || "\u00A0"}
          </div>
        );
      })}
    </div>
  );
}

export function EditToolRenderer({ args, status, result, context }: ToolRendererProps) {
  const isMobile = useMobile();
  const filePath = args?.path as string | undefined;
  const oldText = args?.oldText as string | undefined;
  const newText = args?.newText as string | undefined;
  const edits = Array.isArray(args?.edits) ? (args.edits as Array<{ oldText: string; newText: string }>) : null;

  const renderDiffs = () => {
    if (oldText != null && newText != null) {
      return (
        <div className="rounded bg-[var(--bg-code)] overflow-hidden">
          {isMobile
            ? <DiffView oldText={oldText} newText={newText} filePath={filePath ?? "file"} />
            : <LazyRichDiff oldText={oldText} newText={newText} filePath={filePath ?? "file"} maxHeight="20rem" />}
        </div>
      );
    }
    if (edits && edits.length > 0) {
      return (
        <div className="rounded bg-[var(--bg-code)] overflow-hidden">
          {edits.map((edit, i) => (
            <div key={i} className={i > 0 ? "border-t border-[var(--border-secondary)]" : ""}>
              {isMobile
                ? <DiffView oldText={edit.oldText} newText={edit.newText} filePath={filePath ?? "file"} />
                : <RichDiff oldText={edit.oldText} newText={edit.newText} filePath={filePath ?? "file"} maxHeight="20rem" />}
            </div>
          ))}
        </div>
      );
    }
    return <pre className="text-xs text-[var(--text-secondary)]">{JSON.stringify(args, null, 2)}</pre>;
  };

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <span className="text-xs text-[var(--text-secondary)] font-mono">{filePath ?? "file"}</span>
        <OpenFileButton filePath={filePath} context={context} />
      </div>

      {renderDiffs()}

      {result && status !== "running" && (
        <div className="text-xs text-[var(--text-tertiary)] italic">{result}</div>
      )}
    </div>
  );
}
