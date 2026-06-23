/**
 * SnapshotUnfurlCard — renders an agent-posted external link as a Telegram/
 * Teams-grade snapshot card: a point-in-time snapshot image + title + domain,
 * with two actions ("View inline" → in-dashboard fullscreen lightbox, "Open
 * source" → live page in a new tab) and optional agent highlight overlays.
 *
 * Provenance (agent-attached): the snapshot image rides the *existing*
 * `pi-asset:` / `asset_register` image-inline path — the agent saves a
 * screenshot locally and references it as the inner image of a titled link
 * (`[![alt](snapshot.png)](href 'snapshot:{…}')`); the bridge inlines the
 * bytes to `pi-asset:<hash>` exactly as it does for any chat image. The card
 * resolves that hash via `SessionAssetsContext`, identically to `PiAssetImg`.
 * Non-`pi-asset:` srcs (`data:`, `http(s):`) are used verbatim — which is what
 * the regression suite + replay-only test instance rely on (no live bridge to
 * register assets).
 *
 * Render-only / history-safe: nothing here mutates the stored message. The
 * raw link text stays in chat history; the directive + highlights are parsed
 * from the agent-authored link title at render time and never written back.
 *
 * Visual contract matches the operator-approved render v2
 * (dashboard-unfurl-preview.html): `.unfurl` card, `.snap-tag`, `.flag-tag`,
 * `.ub` body, `b-inline` / `b-source` buttons.
 */
import React, { useState } from "react";
import { useSessionAssets } from "../lib/SessionAssetsContext.js";
import { ImageLightbox } from "./ImageLightbox.js";
import { domainFromHref, type UnfurlDirective } from "../lib/unfurl-directive.js";

interface Props {
  /** External href the card links to (the live page for "Open source"). */
  href: string;
  /** Raw inner-image src (`pi-asset:<hash>`, `data:`, or `http(s):`). */
  imageSrc: string;
  /** Inner-image alt text — the default card title. */
  alt: string;
  /** Parsed directive (marker + optional metadata + highlights). */
  directive: UnfurlDirective;
  /**
   * Graceful-fallback renderer. Called when the snapshot image can't be
   * resolved (unresolved `pi-asset:` hash) so the card degrades to the
   * plain anchor exactly as the link rendered before the feature.
   */
  renderFallback: () => React.ReactElement;
}

/**
 * Resolve a raw image src to a directly-usable URL.
 * Returns null for an unresolved `pi-asset:` hash (→ graceful fallback).
 */
function useResolvedSnapshotSrc(imageSrc: string): string | null {
  const assets = useSessionAssets();
  if (imageSrc.startsWith("pi-asset:")) {
    const hash = imageSrc.slice("pi-asset:".length);
    const asset = assets[hash];
    if (!asset) return null;
    return `data:${asset.mimeType};base64,${asset.data}`;
  }
  return imageSrc;
}

export function SnapshotUnfurlCard({ href, imageSrc, alt, directive, renderFallback }: Props) {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const resolvedSrc = useResolvedSnapshotSrc(imageSrc);

  // Graceful fallback: no snapshot bytes (yet) → render the plain link, exactly
  // as before the feature. This is the zero-regression bar's explicit assertion.
  if (!resolvedSrc) {
    return renderFallback();
  }

  const title = directive.title || alt || "Snapshot";
  const domain = directive.domain || domainFromHref(href);
  const flagged = directive.highlights.length;
  const desc =
    directive.desc ||
    (flagged > 0
      ? `Snapshot with ${flagged} area${flagged === 1 ? "" : "s"} highlighted for you. Quick-check fullscreen, here — or open the live page.`
      : "Point-in-time snapshot — view it fullscreen here, or open the live page.");

  const openLightbox = () => setLightboxOpen(true);

  return (
    <span
      data-testid="snapshot-unfurl-card"
      className="block mt-2.5 rounded-[11px] overflow-hidden border border-[var(--border-secondary)] bg-[var(--bg-tertiary)] max-w-[440px]"
      style={{ borderLeft: "3px solid var(--blue-400, #60a5fa)" }}
    >
      {/* Media */}
      <span
        data-testid="snapshot-unfurl-media"
        onClick={openLightbox}
        className="relative block h-[200px] overflow-hidden border-b border-[var(--border-secondary)] cursor-zoom-in group"
        style={{ background: "#0d1117" }}
      >
        <img
          src={resolvedSrc}
          alt={alt}
          className="w-full h-full block"
          style={{ objectFit: "cover", objectPosition: "top center" }}
        />
        <span
          className="absolute top-2 left-2 font-mono text-[9px] tracking-wide text-[var(--text-secondary)] rounded-[5px] px-1.5 py-0.5 border border-[var(--border-subtle)]"
          style={{ background: "rgba(10,10,10,.72)", backdropFilter: "blur(3px)" }}
        >
          ◷ snapshot{directive.ts ? ` · ${directive.ts}` : ""}
        </span>
        {flagged > 0 && (
          <span
            data-testid="snapshot-unfurl-flag"
            className="absolute top-2 right-2 font-mono text-[9px] rounded-[5px] px-2 py-0.5 font-bold flex gap-1.5 items-center"
            style={{ background: "var(--amber-bright, #fbbf24)", color: "#1a1400" }}
          >
            {flagged} flagged
          </span>
        )}
        <span className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity" style={{ background: "rgba(8,10,14,.34)" }}>
          <span className="font-mono text-[11px] text-white rounded-lg px-3 py-1.5 border border-[var(--border-subtle)]" style={{ background: "rgba(10,10,10,.7)" }}>
            ⤢ click to view inline
          </span>
        </span>
      </span>

      {/* Body */}
      <span className="block px-3.5 pt-2.5 pb-3">
        <span className="font-mono text-[10.5px] text-[var(--text-tertiary)] flex items-center gap-1.5 mb-1.5">
          <span
            className="w-[13px] h-[13px] rounded-[3px] flex-none"
            style={{ background: "linear-gradient(135deg,var(--blue-400,#60a5fa),#2f9d8c)" }}
          />
          {domain} · point-in-time snapshot
        </span>
        <span data-testid="snapshot-unfurl-title" className="block text-[14.5px] font-semibold text-[var(--text-primary)] mb-1 leading-tight">
          {title}
        </span>
        <span className="block text-[12.5px] text-[var(--text-secondary)] leading-snug mb-2.5">
          {desc}
        </span>
        <span className="flex gap-2 flex-wrap">
          <button
            type="button"
            data-testid="snapshot-unfurl-view-inline"
            onClick={openLightbox}
            className="font-mono text-[11.5px] rounded-lg px-3 py-2 cursor-pointer inline-flex items-center gap-1.5 font-semibold border"
            style={{ background: "var(--blue-400, #60a5fa)", color: "#0a0a0a", borderColor: "var(--blue-400, #60a5fa)" }}
          >
            ⤢ View inline
          </button>
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="snapshot-unfurl-open-source"
            className="font-mono text-[11.5px] rounded-lg px-3 py-2 cursor-pointer inline-flex items-center gap-1.5 border border-[var(--border-secondary)] bg-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)] no-underline"
          >
            ↗ Open source
          </a>
        </span>
      </span>

      {lightboxOpen && (
        <ImageLightbox
          src={resolvedSrc}
          alt={alt}
          highlights={directive.highlights}
          caption={directive.caption}
          sourceHref={href}
          onClose={() => setLightboxOpen(false)}
        />
      )}
    </span>
  );
}
