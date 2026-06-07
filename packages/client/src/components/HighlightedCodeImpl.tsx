/**
 * HighlightedCodeImpl — the heavy half of HighlightedCode.
 *
 * This module statically imports react-syntax-highlighter (Prism) and the
 * 10-theme syntax-theme graph. It is loaded ONLY via React.lazy from
 * HighlightedCode.tsx, so it lands in its own async chunk and is never part
 * of the eager home bundle. Default-exported for React.lazy.
 *
 * See change: lazy-split-heavy-client-chunks.
 */
import React from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { useThemeContext } from "./ThemeProvider.js";
import { getSyntaxTheme } from "../lib/syntax-theme.js";
import type { HighlightedCodeProps } from "./HighlightedCode.js";

export default function HighlightedCodeImpl({
  code,
  language,
  showLineNumbers,
  startingLineNumber,
  customStyle,
}: HighlightedCodeProps) {
  const { resolved: theme, themeName } = useThemeContext();
  const syntaxStyle = getSyntaxTheme(theme, themeName);
  return (
    <SyntaxHighlighter
      style={syntaxStyle}
      language={language}
      PreTag="div"
      showLineNumbers={showLineNumbers}
      startingLineNumber={startingLineNumber}
      customStyle={customStyle}
    >
      {code}
    </SyntaxHighlighter>
  );
}
