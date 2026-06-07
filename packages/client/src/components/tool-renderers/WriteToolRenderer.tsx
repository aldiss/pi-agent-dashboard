import React from "react";
// HighlightedCode lazy-loads react-syntax-highlighter + syntax-theme so the
// Prism graph stays out of the eager bundle. See change: lazy-split-heavy-client-chunks.
import { HighlightedCode } from "../HighlightedCode.js";
import type { ToolRendererProps } from "./types.js";
import { OpenFileButton } from "./OpenFileButton.js";
import { detectLanguage } from "./lang-detect.js";

export function WriteToolRenderer({ args, status, result, context }: ToolRendererProps) {
  const filePath = args?.path as string | undefined;
  const content = args?.content as string | undefined;
  const language = detectLanguage(filePath);

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <span className="text-xs text-[var(--text-secondary)] font-mono">{filePath ?? "file"}</span>
        <OpenFileButton filePath={filePath} context={context} />
      </div>

      {status === "running" && !content && (
        <div className="text-xs text-[var(--text-muted)] italic">Writing…</div>
      )}

      {content && (
        <div className="max-h-80 overflow-auto rounded text-xs">
          {language ? (
            <HighlightedCode
              code={content}
              language={language}
              showLineNumbers={true}
              customStyle={{ margin: 0, padding: "0.5rem", fontSize: "0.7rem", background: 'var(--bg-code)' }}
            />
          ) : (
            <pre className="whitespace-pre-wrap text-[var(--text-secondary)] p-2 bg-[var(--bg-code)] rounded">{content}</pre>
          )}
        </div>
      )}

      {result && status !== "running" && (
        <div className="text-xs text-[var(--text-tertiary)] italic">{result}</div>
      )}
    </div>
  );
}
