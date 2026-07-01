import React, { useEffect, useRef } from "react";
import { Icon } from "@mdi/react";
import { mdiClose } from "@mdi/js";
import { DialogPortal } from "./DialogPortal.js";
import { useZoomPan } from "../hooks/useZoomPan.js";
import type { UnfurlHighlight } from "../lib/unfurl-directive.js";

const BACKDROP_ID = "lightbox-backdrop";

interface Props {
  src: string;
  alt: string;
  onClose: () => void;
  /**
   * Optional agent-flagged regions to overlay on the image (snapshot-unfurl).
   * When omitted or empty, the lightbox renders EXACTLY as before — the
   * zoom/pan image path is byte-identical to the pre-feature behavior, which
   * the existing ImageLightbox tests assert. When present, an annotation
   * layer (numbered pins + amber region boxes + an optional caption/source
   * bar) is rendered on top, and zoom/pan is disabled so the percentage-based
   * overlay geometry stays aligned with the image.
   */
  highlights?: UnfurlHighlight[];
  /**
   * Optional caption shown in the annotation bar (snapshot-unfurl only).
   */
  caption?: string;
  /**
   * Optional "open source" href shown in the annotation bar (snapshot-unfurl
   * only). External links open in a new tab with reverse-tabnabbing guard.
   */
  sourceHref?: string;
}

export function ImageLightbox({ src, alt, onClose, highlights, caption, sourceHref }: Props) {
  const annotated = Array.isArray(highlights) && highlights.length > 0;
  if (annotated) {
    return (
      <AnnotatedLightbox
        src={src}
        alt={alt}
        onClose={onClose}
        highlights={highlights!}
        caption={caption}
        sourceHref={sourceHref}
      />
    );
  }
  return <PlainLightbox src={src} alt={alt} onClose={onClose} />;
}

/**
 * The original, unmodified lightbox: backdrop + zoom/pan image. Extracted
 * verbatim so the no-highlights path is provably unchanged.
 */
function PlainLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Close on Escape + backdrop click + the close button (document listeners for
  // portal compat: DialogPortal renders outside the React root, so React onClick
  // is unreliable here — native listeners are the proven pattern in this file).
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target?.dataset?.testid === BACKDROP_ID) {
        onCloseRef.current();
        return;
      }
      // The close button lives inside the backdrop; a tap may land on its inner
      // icon, so match the nearest close-button ancestor.
      if (target?.closest?.('[data-testid="lightbox-close"]')) {
        onCloseRef.current();
      }
    };
    document.addEventListener("keydown", handleKey);
    document.addEventListener("click", handleClick);
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.removeEventListener("click", handleClick);
    };
  }, []);

  const { state, handlers } = useZoomPan({ minScale: 0.25, maxScale: 10 });

  return (
    <DialogPortal>
      <div
        data-testid="lightbox-backdrop"
        className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 cursor-zoom-out"
      >
        {/* Always-visible close affordance. Critical on mobile / PWA: there is no
            Esc key, and the backdrop margin around a full-screen photo is too thin
            to tap reliably (the photo itself is the zoom/pan target). Without this
            the only escape was force-quitting the app. */}
        <button
          type="button"
          aria-label="Close image"
          data-testid="lightbox-close"
          className="fixed z-[10000] flex items-center justify-center w-11 h-11 rounded-full border border-white/25 bg-black/55 text-white/90 backdrop-blur-sm transition-colors hover:bg-black/80 hover:text-white cursor-pointer"
          style={{
            top: "calc(env(safe-area-inset-top, 0px) + 12px)",
            right: "calc(env(safe-area-inset-right, 0px) + 12px)",
          }}
        >
          <Icon path={mdiClose} size={1} />
        </button>
        <div
          className="relative max-w-[90vw] max-h-[90vh] cursor-grab active:cursor-grabbing"
          onWheel={handlers.onWheel}
          onPointerDown={handlers.onPointerDown}
          onPointerMove={handlers.onPointerMove}
          onPointerUp={handlers.onPointerUp}
          onTouchMove={handlers.onTouchMove as unknown as React.TouchEventHandler}
          onTouchEnd={handlers.onTouchEnd as unknown as React.TouchEventHandler}
          onDoubleClick={handlers.onDoubleClick}
          style={{ touchAction: "none" }}
        >
          <img
            src={src}
            alt={alt}
            className="max-w-[90vw] max-h-[90vh] object-contain select-none"
            style={{
              transform: `translate(${state.translateX}px, ${state.translateY}px) scale(${state.scale})`,
              transformOrigin: "0 0",
            }}
            draggable={false}
          />
        </div>
      </div>
    </DialogPortal>
  );
}

/**
 * Annotated variant (snapshot-unfurl): the same backdrop + Esc/backdrop-close
 * contract as {@link PlainLightbox}, plus a top bar (caption + optional open-
 * source + close), a numbered legend strip, and the image overlaid with the
 * agent's highlight regions. Zoom/pan is intentionally NOT used here so the
 * percentage-positioned overlays stay locked to the image (matches the
 * approved render's fullscreen view).
 */
function AnnotatedLightbox({
  src,
  alt,
  onClose,
  highlights,
  caption,
  sourceHref,
}: {
  src: string;
  alt: string;
  onClose: () => void;
  highlights: UnfurlHighlight[];
  caption?: string;
  sourceHref?: string;
}) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Identical close contract to PlainLightbox: Esc + backdrop click.
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target?.dataset?.testid === BACKDROP_ID) {
        onCloseRef.current();
      }
    };
    document.addEventListener("keydown", handleKey);
    document.addEventListener("click", handleClick);
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.removeEventListener("click", handleClick);
    };
  }, []);

  const labelled = highlights.filter((h) => h.label);

  return (
    <DialogPortal>
      <div
        data-testid={BACKDROP_ID}
        className="fixed inset-0 z-[9999] flex flex-col bg-black/90"
        style={{
          // Respect mobile safe areas (iPhone notch / Dynamic Island / home
          // indicator) so the top bar + close control don't render under the
          // status bar. The black background still fills inset-0; only the
          // flex content is inset below the safe areas.
          paddingTop: "env(safe-area-inset-top)",
          paddingBottom: "env(safe-area-inset-bottom)",
          paddingLeft: "env(safe-area-inset-left)",
          paddingRight: "env(safe-area-inset-right)",
        }}
      >
        {/* Bar */}
        <div
          className="flex items-center gap-3.5 px-4.5 py-3 border-b border-[var(--border-secondary)]"
          style={{ background: "rgba(15,15,15,.85)" }}
        >
          <div className="text-[13px] text-[var(--text-primary)] leading-tight">
            <span>{caption || `${highlights.length} area${highlights.length === 1 ? "" : "s"} flagged for your attention`}</span>
            <small className="block font-mono text-[10px] text-[var(--text-tertiary)] mt-0.5">
              fullscreen · inside the dashboard · no new tab
            </small>
          </div>
          <div className="flex-1" />
          {sourceHref && (
            <a
              href={sourceHref}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="lightbox-open-source"
              className="font-mono text-xs rounded-lg px-3 py-2 border border-[var(--border-secondary)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] inline-flex gap-1.5 items-center no-underline"
            >
              ↗ open source
            </a>
          )}
          <button
            type="button"
            onClick={() => onCloseRef.current()}
            data-testid="lightbox-close"
            className="font-mono text-xs rounded-lg px-3 py-2 border border-[var(--border-secondary)] bg-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)] inline-flex gap-1.5 items-center"
          >
            ✕ close
          </button>
        </div>

        {/* Legend (only entries that carry a label) */}
        {labelled.length > 0 && (
          <div
            className="flex gap-4.5 flex-wrap px-4.5 py-2.5 border-b border-[var(--border-subtle)] font-mono text-[11px] text-[var(--text-secondary)]"
            style={{ background: "rgba(10,10,10,.6)" }}
          >
            {labelled.map((h) => (
              <span key={h.n} className="flex items-center gap-2">
                <span
                  className="w-[18px] h-[18px] rounded-[5px] text-[10px] font-bold flex items-center justify-center flex-none"
                  style={{ background: "var(--amber-bright, #fbbf24)", color: "#1a1400" }}
                >
                  {h.n}
                </span>
                {h.label}
              </span>
            ))}
          </div>
        )}

        {/* Stage */}
        <div className="flex-1 overflow-auto flex justify-center p-5.5">
          <div
            data-testid="lightbox-annotated-imgwrap"
            className="relative self-start"
            style={{ width: "min(680px,94vw)", height: "max-content" }}
          >
            <img
              src={src}
              alt={alt}
              className="w-full block rounded-[10px] border border-[var(--border-secondary)] select-none"
              draggable={false}
            />
            {highlights.map((h) => (
              <div
                key={h.n}
                data-testid="lightbox-highlight"
                className="absolute rounded-lg"
                style={{
                  top: `${h.top}%`,
                  left: `${h.left}%`,
                  width: `${h.width}%`,
                  height: `${h.height}%`,
                  border: "2px solid var(--amber-bright, #fbbf24)",
                  boxShadow: "0 0 22px 3px rgba(251,191,36,.45)",
                  background: "rgba(251,191,36,.07)",
                }}
              >
                <span
                  className="absolute w-6 h-6 rounded-full font-mono font-bold text-xs flex items-center justify-center"
                  style={{
                    top: "-12px",
                    left: "-12px",
                    background: "var(--amber-bright, #fbbf24)",
                    color: "#1a1400",
                    boxShadow: "0 2px 8px rgba(0,0,0,.5)",
                  }}
                >
                  {h.n}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </DialogPortal>
  );
}
