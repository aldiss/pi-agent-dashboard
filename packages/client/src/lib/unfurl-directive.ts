/**
 * Snapshot-unfurl directive parser.
 *
 * The agent opts a chat link into the snapshot-unfurl card by attaching a
 * markdown link *title* directive:
 *
 *   [![Architecture map](snapshot.png)](https://host/page 'snapshot')
 *   [![Architecture map](snapshot.png)](https://host/page 'snapshot:{"ts":"12:47","highlights":[...]}')
 *
 * The title is agent-authored markdown content. The dashboard only ever
 * *reads* it at render time — it never writes the parsed result back into
 * the stored message. So the feature is render-only and history-safe: the
 * `content` string persisted in the session JSONL is byte-for-byte what the
 * agent wrote, including the directive itself.
 *
 * Why the title channel (not asset metadata / a new protocol message):
 *  - Zero protocol surface — no bridge/server/types changes, so the landing
 *    footprint is one client seam (`MarkdownContent`'s `a` renderer).
 *  - The bridge's `markdown-image-inliner` rewrites only the inner
 *    `![alt](src)` token of a `[![alt](src)](href "title")` construct; the
 *    wrapping link href + title pass through untouched, so a `pi-asset:`
 *    snapshot still carries its directive after inlining.
 *  - Highlight regions are bounded, percentage-based geometry — they belong
 *    next to the link that owns them, not in a global asset registry keyed by
 *    a content hash the agent can't predict.
 *
 * This module is PURE (no React, no DOM) so every branch is unit-testable
 * with plain string fixtures.
 */

/** Recognised directive markers (case-insensitive), longest first. */
const MARKERS = ["snapshot", "unfurl"] as const;

/** Hard caps so a malformed / hostile directive can't blow up the render. */
const MAX_HIGHLIGHTS = 16;
const MAX_LABEL_LEN = 80;
const MAX_TEXT_LEN = 280;

/**
 * A single agent-authored highlight region, expressed as percentages of the
 * rendered snapshot's width/height so it survives any display scaling. All
 * four geometry fields are clamped to [0, 100]; `label` is trimmed to
 * {@link MAX_LABEL_LEN}. `n` is the 1-based pin number shown in the overlay.
 */
export interface UnfurlHighlight {
  /** Distance from the top edge, as a percent of image height. */
  top: number;
  /** Distance from the left edge, as a percent of image width. */
  left: number;
  /** Region width, as a percent of image width. */
  width: number;
  /** Region height, as a percent of image height. */
  height: number;
  /** Optional short caption rendered beside the region in the lightbox. */
  label?: string;
  /** 1-based pin number (assigned during parse). */
  n: number;
}

/**
 * Parsed snapshot directive. Presence of this object (i.e. a non-null parse)
 * is what flips the `a` renderer from a plain anchor into the snapshot card.
 */
export interface UnfurlDirective {
  /** Optional override for the card title (defaults to the image `alt`). */
  title?: string;
  /** Optional one-line description under the title. */
  desc?: string;
  /** Optional point-in-time label rendered in the snapshot tag (e.g. "12:47"). */
  ts?: string;
  /** Optional override for the displayed domain (defaults to the href host). */
  domain?: string;
  /** Optional caption shown in the lightbox bar (defaults to a derived line). */
  caption?: string;
  /** Agent-flagged regions, render-only, bounded to {@link MAX_HIGHLIGHTS}. */
  highlights: UnfurlHighlight[];
}

/** Clamp a value to [0, 100]; non-finite → fallback. */
function clampPct(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(100, Math.max(0, n));
}

/** Coerce + trim an unknown to a bounded string, or undefined. */
function boundedText(v: unknown, max = MAX_TEXT_LEN): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (!t) return undefined;
  return t.length > max ? t.slice(0, max) : t;
}

/**
 * Split a directive title into its marker and (optional) JSON payload.
 * Returns null when the title is absent or doesn't begin with a known marker.
 *
 * Accepts both bare markers (`snapshot`) and payload form (`snapshot:{…}`).
 * The marker match is case-insensitive and tolerates surrounding whitespace.
 */
function splitMarker(title: string | undefined): { payload: string } | null {
  if (!title) return null;
  const trimmed = title.trim();
  const lower = trimmed.toLowerCase();
  for (const marker of MARKERS) {
    if (lower === marker) return { payload: "" };
    if (lower.startsWith(marker)) {
      // Next char must be a separator (`:` or whitespace) so we don't match
      // e.g. "snapshotting" as the marker "snapshot".
      const sep = trimmed.charAt(marker.length);
      if (sep === ":" || sep === " " || sep === "\t") {
        return { payload: trimmed.slice(marker.length + 1).trim() };
      }
    }
  }
  return null;
}

/**
 * Normalise one raw highlight entry into an {@link UnfurlHighlight}, or null
 * if it carries no usable geometry. Accepts both the terse
 * `{t,l,w,h,label}` and verbose `{top,left,width,height,label}` shapes.
 */
function normaliseHighlight(raw: unknown, n: number): UnfurlHighlight | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const top = clampPct(r.top ?? r.t);
  const left = clampPct(r.left ?? r.l);
  const width = clampPct(r.width ?? r.w);
  const height = clampPct(r.height ?? r.h);
  // A zero-area region is meaningless — drop it.
  if (width <= 0 || height <= 0) return null;
  const label = boundedText(r.label ?? r.lab, MAX_LABEL_LEN);
  return { top, left, width, height, ...(label ? { label } : {}), n };
}

/**
 * Parse a markdown link title into an {@link UnfurlDirective}.
 *
 * Contract:
 *  - Returns null when `title` is absent or not a recognised directive — the
 *    caller then renders the link exactly as it does today (graceful, the
 *    zero-regression default).
 *  - Returns a directive (possibly with an empty `highlights` array) when the
 *    marker is present, EVEN IF the JSON payload is malformed. The marker is
 *    an explicit opt-in; a typo'd payload should still show the card (just
 *    without highlights) rather than silently falling back to a bare link.
 */
export function parseUnfurlDirective(title: string | undefined): UnfurlDirective | null {
  const split = splitMarker(title);
  if (!split) return null;

  const directive: UnfurlDirective = { highlights: [] };
  if (!split.payload) return directive;

  let parsed: unknown;
  try {
    parsed = JSON.parse(split.payload);
  } catch {
    // Marker present but payload unparseable → card with no highlights.
    return directive;
  }
  if (!parsed || typeof parsed !== "object") return directive;

  const p = parsed as Record<string, unknown>;
  directive.title = boundedText(p.title);
  directive.desc = boundedText(p.desc ?? p.description);
  directive.ts = boundedText(p.ts ?? p.time, 24);
  directive.domain = boundedText(p.domain, 120);
  directive.caption = boundedText(p.caption);

  const rawHighlights = Array.isArray(p.highlights) ? p.highlights : [];
  for (const raw of rawHighlights) {
    if (directive.highlights.length >= MAX_HIGHLIGHTS) break;
    const hl = normaliseHighlight(raw, directive.highlights.length + 1);
    if (hl) directive.highlights.push(hl);
  }

  return directive;
}

/**
 * Derive the display domain for a snapshot card from its href, falling back to
 * the raw href when it can't be parsed (e.g. a non-URL string). Used when the
 * directive doesn't carry an explicit `domain`.
 */
export function domainFromHref(href: string | undefined): string {
  if (!href) return "";
  try {
    const base = typeof window !== "undefined" ? window.location.origin : "http://localhost";
    const u = new URL(href, base);
    // host already includes a non-default port (e.g. "100.126.219.9:9090").
    return u.host || href;
  } catch {
    return href;
  }
}
