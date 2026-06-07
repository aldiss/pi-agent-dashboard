import React, { useState } from "react";
// HighlightedCode lazy-loads react-syntax-highlighter + syntax-theme so the
// Prism graph stays out of the eager bundle. See change: lazy-split-heavy-client-chunks.
import { HighlightedCode } from "../HighlightedCode.js";
import type { ToolRendererProps } from "./types.js";
import { OpenFileButton } from "./OpenFileButton.js";
import { detectLanguage } from "./lang-detect.js";
import { ImageLightbox } from "../ImageLightbox.js";

export function ReadToolRenderer({ args, status, result, images, context }: ToolRendererProps) {
  const filePath = args?.path as string | undefined;
  const offset = args?.offset as number | undefined;
  const limit = args?.limit as number | undefined;
  const language = detectLanguage(filePath);
  const hasImages = images && images.length > 0;

  const subtitle = [
    offset && `from line ${offset}`,
    limit && `${limit} lines`,
  ].filter(Boolean).join(", ");

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <span className="text-xs text-[var(--text-secondary)] font-mono">{filePath ?? "file"}</span>
        {subtitle && <span className="text-[10px] text-[var(--text-muted)]">({subtitle})</span>}
        <OpenFileButton filePath={filePath} line={offset} context={context} />
      </div>

      {status === "running" && !result && !hasImages && (
        <div className="text-xs text-[var(--text-muted)] italic">Reading…</div>
      )}

      {hasImages && (
        <ReadToolImages images={images!} filePath={filePath} />
      )}

      {!hasImages && result && (
        <div className="max-h-80 overflow-auto rounded text-xs">
          {language ? (
            <HighlightedCode
              code={result}
              language={language}
              showLineNumbers={true}
              startingLineNumber={offset ?? 1}
              customStyle={{ margin: 0, padding: "0.5rem", fontSize: "0.7rem", background: 'var(--bg-code)' }}
            />
          ) : (
            <pre className="whitespace-pre-wrap text-[var(--text-secondary)] p-2 bg-[var(--bg-code)] rounded">{result}</pre>
          )}
        </div>
      )}
    </div>
  );
}

function ReadToolImages({ images, filePath }: { images: ToolRendererProps["images"]; filePath?: string }) {
  const [lightboxSrc, setLightboxSrc] = useState<{ src: string; alt: string } | null>(null);
  return (
    <>
      <div className="flex gap-2 flex-wrap">
        {images!.map((img, i) => {
          const src = `data:${img.mimeType};base64,${img.data}`;
          const alt = filePath ?? `Image ${i + 1}`;
          return (
            <img
              key={i}
              src={src}
              alt={alt}
              className="max-w-[512px] max-h-[512px] rounded border border-white/20 object-contain cursor-pointer"
              onClick={() => setLightboxSrc({ src, alt })}
            />
          );
        })}
      </div>
      {lightboxSrc && (
        <ImageLightbox src={lightboxSrc.src} alt={lightboxSrc.alt} onClose={() => setLightboxSrc(null)} />
      )}
    </>
  );
}
