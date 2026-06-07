/**
 * HighlightedCode — eager, lightweight lazy boundary around the heavy
 * `react-syntax-highlighter` (Prism) + 10-theme `syntax-theme` graph.
 *
 * The actual highlighter lives in HighlightedCodeImpl.tsx, pulled in via
 * React.lazy → its own async chunk. This wrapper imports ONLY a type from
 * the impl (erased at build), so nothing in the eager entry graph drags
 * react-syntax-highlighter or the Prism style modules into the home bundle.
 *
 * Fallback renders the raw code in a <pre> so the user sees content
 * immediately (no blank flash) while the highlighter chunk streams in.
 *
 * See change: lazy-split-heavy-client-chunks.
 */
import React, { Suspense } from "react";

export interface HighlightedCodeProps {
  code: string;
  language: string;
  showLineNumbers?: boolean;
  startingLineNumber?: number;
  customStyle?: React.CSSProperties;
}

const HighlightedCodeImpl = React.lazy(() => import("./HighlightedCodeImpl.js"));

export function HighlightedCode(props: HighlightedCodeProps) {
  const fallbackStyle: React.CSSProperties = {
    margin: 0,
    padding: "0.5rem",
    whiteSpace: "pre",
    overflowX: "auto",
    fontFamily: "var(--font-mono, monospace)",
    fontSize: props.customStyle?.fontSize,
    background: props.customStyle?.background ?? "var(--bg-code)",
  };
  return (
    <Suspense
      fallback={
        <pre style={fallbackStyle}>
          <code>{props.code}</code>
        </pre>
      }
    >
      <HighlightedCodeImpl {...props} />
    </Suspense>
  );
}
