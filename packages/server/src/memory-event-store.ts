/**
 * In-memory event store with LRU eviction.
 * Replaces SQLite-backed event-store.ts.
 */
import type { DashboardEvent } from "@blackbelt-technology/pi-dashboard-shared/types.js";

export interface StoredEvent {
  seq: number;
  event: DashboardEvent;
}

export interface EventStore {
  /** Insert an event, returns assigned sequence number */
  insertEvent(sessionId: string, event: DashboardEvent): number;
  /** Get events for a session starting from minSeq (inclusive) */
  getEvents(sessionId: string, minSeq: number): StoredEvent[];
  /** Get a single event by sessionId and seq */
  getEvent(sessionId: string, seq: number): DashboardEvent | undefined;
  /** Delete all events for a specific session */
  deleteEventsForSession(sessionId: string): number;
  /** Check if session has events in memory */
  hasEvents(sessionId: string): boolean;
  /** Return the highest seq for a session, or 0 if no events */
  getMaxSeq(sessionId: string): number;
  /** Number of cached sessions */
  sessionCount(): number;
  /** Total serialized bytes retained across all session buffers. */
  bytesRetained(): number;
  /** Serialized bytes retained for a single session (0 if unknown). */
  sessionBytes(sessionId: string): number;
}

/** Stored event plus the serialized byte size of its (sanitized) data — internal only. */
interface MeasuredEvent extends StoredEvent {
  bytes: number;
}

interface SessionBuffer {
  events: MeasuredEvent[];
  nextSeq: number;
  lastAccess: number;
  /** Sum of `bytes` across this buffer's events. */
  bytesRetained: number;
}

export const DEFAULT_MAX_CACHED_SESSIONS = 100;
export const DEFAULT_MAX_EVENTS_PER_SESSION = 5000;

/** Default max size for any string field within event data */
const DEFAULT_MAX_STRING_SIZE = 4_000;
/**
 * Max total serialized size for an individual event's data, in bytes-ish
 * (JSON string length). This is a HARD cap, enforced on every insert as the
 * final backstop after field-level sanitization. Generous enough not to
 * mangle ordinary tool output, tight enough to bound the multi-MB nested
 * MCP/Tavily payloads that drive the heap floor.
 */
const MAX_EVENT_DATA_SIZE = 64_000;
/**
 * Max recursion depth for the sanitizer walk. Deep enough to reach the nested
 * `raw_content` observed at `message.details.mcpResult.structuredContent.results[*]`
 * (depth ~6), bounded to keep a pathological/cyclic object from running away.
 */
const MAX_SANITIZE_DEPTH = 100;
/** Arrays longer than this are elided to a marker (only when truncation is enabled). */
const MAX_ARRAY_LENGTH = 50;
/**
 * Per-image ceiling for preserved inline base64 `data` (with a sibling
 * `mimeType`). Preserved image bytes are EXEMPT from MAX_EVENT_DATA_SIZE — they
 * were retained inline before this change and the load-bearing leak is text
 * `raw_content`, not images — but a single pathological paste is still bounded
 * here so it cannot blow the heap on its own. A real screenshot/photo
 * (~100 KB–2.7 MB raw → ~133 KB–3.6 MB base64) stays well under this.
 */
const MAX_EVENT_IMAGE_BYTES = 4_000_000;

/** Mutable walk context — accumulates preserved-image bytes so the byte cap can exempt them. */
interface SanitizeCtx {
  imageBytes: number;
}

/** Serialize defensively; returns null on cycle / unserializable value. */
function safeStringify(value: unknown): string | null {
  try {
    const s = JSON.stringify(value);
    return s === undefined ? null : s;
  } catch {
    return null;
  }
}

/** Replacement marker for a stripped `raw_content` field, sized for diagnostics. */
function strippedMarker(val: unknown): string {
  let len = 0;
  if (typeof val === "string") len = val.length;
  else {
    const s = safeStringify(val);
    len = s ? s.length : 0;
  }
  return `[stripped ${Math.round(len / 1024)}kb raw_content]`;
}

/** Pull a short text preview out of a message.content (string or block array). */
function previewContent(content: unknown, max = 200): string | undefined {
  if (typeof content === "string") return content.slice(0, max);
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object" && typeof (block as Record<string, unknown>).text === "string") {
        return ((block as Record<string, unknown>).text as string).slice(0, max);
      }
    }
  }
  return undefined;
}

/**
 * Full operator-visible text of a user/assistant chat message's `content` — the
 * whole string, or EVERY text block joined, with NO length cap. Used by the
 * over-cap summary so chat text is never clipped to a short preview.
 *
 * Chat text is the operator's and the agent's actual words; it must round-trip
 * WHOLE. The per-string cap already exempts it (deepSanitize `preserveStrings`,
 * change 19f2256) and inline images are exempt from the byte cap (change
 * 34ff964) — this carries the same guarantee into the total-byte-cap summary.
 * Non-text blocks (thinking, signatures, tool payloads) are intentionally
 * DROPPED: they are the bloat the summary exists to shed, not operator-visible
 * content. Returns undefined when there is no text (e.g. an image-only message).
 */
function chatMessageText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      const text = block && typeof block === "object" ? (block as Record<string, unknown>).text : undefined;
      if (typeof text === "string") parts.push(text);
    }
    return parts.length > 0 ? parts.join("") : undefined;
  }
  return undefined;
}

/**
 * Recursively sanitize event data:
 *  - ALWAYS strip `raw_content` / `rawContent` at any depth (the nested
 *    MCP/Tavily web-page payloads are the load-bearing leak shape), regardless
 *    of whether per-string truncation is enabled. This is defense-in-depth: it
 *    holds even if `maxSize` is mis-configured back to 0.
 *  - When `maxSize > 0`: truncate over-long strings, elide oversized arrays,
 *    and shrink `thinking` blocks.
 *  - Preserve base64 image `data` when a sibling `mimeType` is present (bounded
 *    per-image by MAX_EVENT_IMAGE_BYTES); accumulate preserved bytes into `ctx`
 *    so the total-byte cap can exempt them.
 *  - Preserve user/assistant message `content` in full (the operator's and the
 *    agent's actual chat text) — exempt from the per-string cap via
 *    `preserveStrings` so messages round-trip WHOLE in BOTH directions. Tool
 *    results (role:"toolResult") stay capped; the raw_content strip + byte
 *    backstop still bound genuinely oversized payloads.
 *
 * Returns a new object/array if anything changed, otherwise the original.
 */
function deepSanitize(obj: unknown, maxSize: number, depth: number, ctx: SanitizeCtx, preserveStrings = false): unknown {
  if (depth > MAX_SANITIZE_DEPTH) return obj;

  if (typeof obj === "string") {
    // `preserveStrings` is set while walking a user/assistant message's content
    // — the operator's and the agent's actual chat text, which must arrive
    // WHOLE (never clipped with the "…[truncated]" marker). The cap still
    // applies to every other string (tool output, metadata, …).
    if (!preserveStrings && maxSize > 0 && obj.length > maxSize) return obj.slice(0, maxSize) + "\n…[truncated]";
    return obj;
  }

  if (Array.isArray(obj)) {
    if (maxSize > 0 && obj.length > MAX_ARRAY_LENGTH) return `[array truncated: ${obj.length} items]`;
    let changed = false;
    const result = obj.map((item) => {
      const t = deepSanitize(item, maxSize, depth + 1, ctx, preserveStrings);
      if (t !== item) changed = true;
      return t;
    });
    return changed ? result : obj;
  }

  if (obj && typeof obj === "object") {
    // A user/assistant message object ({ role, content }) carries the operator's
    // or the agent's chat text. Recurse into ITS `content` with string
    // preservation so the message round-trips WHOLE in both directions. Tool
    // results (role:"toolResult") are deliberately excluded — their potentially
    // huge output stays subject to the cap + raw_content strip + byte backstop.
    const role = (obj as Record<string, unknown>).role;
    const isChatMessage = role === "user" || role === "assistant";
    let changed = false;
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      // ALWAYS strip raw_content / rawContent — at any depth, any config.
      if (key === "raw_content" || key === "rawContent") {
        result[key] = strippedMarker(val);
        changed = true;
        continue;
      }
      // Preserve base64 image data — skip truncation when a sibling mimeType
      // exists — but bound a pathological single image and tally the bytes so
      // the total-byte cap can exempt legitimate images.
      if (key === "data" && typeof val === "string" && "mimeType" in obj) {
        if (val.length > MAX_EVENT_IMAGE_BYTES) {
          result[key] = `[stripped ${Math.round(val.length / 1024)}kb image]`;
          changed = true;
        } else {
          result[key] = val;
          ctx.imageBytes += val.length;
        }
        continue;
      }
      // Shrink 'thinking' blocks — large and not shown in chat.
      if (key === "thinking" && typeof val === "string" && maxSize > 0 && val.length > maxSize) {
        result[key] = val.slice(0, 500) + "\n…[truncated]";
        changed = true;
        continue;
      }
      // Chat source text and the complete finalized delivery contract must both
      // survive replay unchanged. Everything else keeps the normal cap.
      const childPreserve = preserveStrings || (
        isChatMessage && (
          key === "content" ||
          key === "operatorDelivery" ||
          key === "operatorDeliveryPresentation"
        )
      );
      const t = deepSanitize(val, maxSize, depth + 1, ctx, childPreserve);
      if (t !== val) changed = true;
      result[key] = t;
    }
    return changed ? result : obj;
  }

  return obj;
}

/**
 * Extract preserved image blocks from a content/images array. Handles both
 * shapes the client reads: `message.content[]`/`result.content[]` blocks
 * ({type:"image", data, mimeType}) and the pre-extracted `data.images[]`
 * entries ({data, mimeType}, no `type` field — see state-replay.ts).
 */
function extractImageBlocks(content: unknown): Array<{ type: "image"; data: string; mimeType: string }> {
  if (!Array.isArray(content)) return [];
  const out: Array<{ type: "image"; data: string; mimeType: string }> = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    // Require base64 data + mimeType. Accept either an explicit type:"image"
    // (content-block shape) or no type at all (pre-extracted images[] shape);
    // reject blocks that declare a non-image type.
    if (typeof b.data !== "string" || typeof b.mimeType !== "string") continue;
    if ("type" in b && b.type !== "image") continue;
    out.push({ type: "image", data: b.data, mimeType: b.mimeType });
  }
  return out;
}

/**
 * Build a compact summary of an over-cap event's data, preserving the fields
 * the UI needs to render a row (tool identity, message role + text) AND any
 * inline image blocks (so a screenshot is never silently lost — image bytes
 * are exempt from the cap, so this path only fires when the NON-image text
 * exceeds the cap). Used only when an event still exceeds MAX_EVENT_DATA_SIZE
 * after field-level sanitization.
 *
 * User/assistant chat text is kept WHOLE (chatMessageText) — it is the
 * operator-visible content and must never be clipped by the byte cap. Only
 * non-chat (tool) message text is reduced to a short preview. The bloat that
 * tripped the cap (large thinking/signature blocks, oversized tool payloads)
 * is shed by keeping just role + text + images.
 */
function summarizeOverCap(data: Record<string, unknown>, bytes: number): Record<string, unknown> {
  const summary: Record<string, unknown> = { __truncated: true, __bytes: bytes };
  for (const k of ["toolCallId", "toolName", "isError", "entryId", "status", "name", "id", "eventType"]) {
    if (k in data) summary[k] = data[k];
  }
  const msg = data.message;
  if (msg && typeof msg === "object") {
    const m = msg as Record<string, unknown>;
    const msgSummary: Record<string, unknown> = {};
    if ("role" in m) msgSummary.role = m.role;
    // Preserve the operator-voice audience stamp through the over-cap summary
    // (Sol fix-cycle-3 F2): the forward stamp is the source of truth for lint
    // scope + visibility; dropping it on a large message let a stamped `agent`
    // row fall through to the retrospective and flip category. Carry it verbatim
    // (valid OR corrupt-present) so the classifier's 3-state reader still sees it.
    if ("audience" in m) msgSummary.audience = m.audience;
    // The reducer accepts plain prose only from this source-bound contract.
    // Preserve the complete object so cold replay has the same proof material
    // as the live message_end path.
    if ("operatorDelivery" in m) msgSummary.operatorDelivery = m.operatorDelivery;
    if ("operatorDeliveryPresentation" in m) {
      msgSummary.operatorDeliveryPresentation = m.operatorDeliveryPresentation;
    }
    // User/assistant chat text is operator-visible and must round-trip WHOLE
    // even when the WHOLE event trips the byte cap (e.g. a streaming
    // message_update bloated by a large thinking/signature block pushes the
    // serialized event over MAX_EVENT_DATA_SIZE). Clipping it to a 200-char
    // preview here is what made a long orchestrator message render as ~4 lines
    // ending mid-`**bold**` (unclosed marker → literal `**`). Keep the full
    // chat text; non-chat (tool) messages keep the short preview as before.
    // See change: event-store-bytecap-preserve-chat.
    const isChatMessage = m.role === "user" || m.role === "assistant";
    const preview = isChatMessage ? chatMessageText(m.content) : previewContent(m.content);
    const imgs = extractImageBlocks(m.content);
    if (imgs.length > 0) {
      // Rebuild a minimal content array: a text preview block (if any) + the
      // images. Matches the {type:"image",data,mimeType} shape the reducer reads
      // from message.content (event-reducer message_start path).
      const content: unknown[] = [];
      if (preview !== undefined) content.push({ type: "text", text: preview });
      content.push(...imgs);
      msgSummary.content = content;
    } else if (preview !== undefined) {
      msgSummary.content = preview;
    }
    summary.message = msgSummary;
  }
  // Tool-result images: live events carry data.result.content[], replayed
  // events carry data.images[] (state-replay pre-extracts). Preserve both so
  // extractToolResultImages still resolves them after summarization.
  const replayImgs = extractImageBlocks(data.images);
  const liveImgs = extractImageBlocks((data.result as Record<string, unknown> | undefined)?.content);
  const toolImgs = replayImgs.length > 0 ? replayImgs : liveImgs;
  if (toolImgs.length > 0) {
    summary.images = toolImgs.map((i) => ({ data: i.data, mimeType: i.mimeType }));
  }
  return summary;
}

/**
 * Sanitize an event and measure its retained serialized size.
 * Pipeline: deep field-level sanitize → hard total-byte cap backstop.
 * Always runs (raw_content strip + byte cap are unconditional); per-string
 * truncation is active only when `maxStringSize > 0`. Preserved inline image
 * bytes are exempt from the cap (bounded per-image during the walk) so a
 * real screenshot is never routed into the over-cap summary path.
 */
function sanitizeEvent(
  event: DashboardEvent,
  maxStringSize: number,
): { event: DashboardEvent; bytes: number } {
  const data = event.data;
  if (!data || typeof data !== "object") {
    // Non-object top-level data: still enforce the byte cap as the final
    // backstop (a forged/oversized primitive must not bypass it).
    const s = safeStringify(data);
    const len = s ? s.length : 0;
    if (len > MAX_EVENT_DATA_SIZE) {
      const marker = { __truncated: true, __bytes: len, __reason: "non-object-data" };
      return { event: { ...event, data: marker }, bytes: safeStringify(marker)?.length ?? 0 };
    }
    return { event, bytes: len };
  }

  const ctx: SanitizeCtx = { imageBytes: 0 };
  const walked = deepSanitize(data, maxStringSize, 0, ctx) as Record<string, unknown>;
  const afterWalk = walked !== data ? { ...event, data: walked } : event;

  const serialized = safeStringify(afterWalk.data);
  if (serialized === null) {
    // Unserializable (cycle/BigInt) — replace with a minimal marker.
    const marker = { __truncated: true, __reason: "unserializable" };
    return { event: { ...afterWalk, data: marker }, bytes: safeStringify(marker)?.length ?? 0 };
  }
  // Exempt preserved-image bytes from the cap decision so a large screenshot
  // does not force text-summarization (and image destruction).
  const effectiveSize = serialized.length - ctx.imageBytes;
  if (effectiveSize > MAX_EVENT_DATA_SIZE) {
    const summary = summarizeOverCap(afterWalk.data as Record<string, unknown>, serialized.length);
    return { event: { ...afterWalk, data: summary }, bytes: safeStringify(summary)?.length ?? 0 };
  }
  return { event: afterWalk, bytes: serialized.length };
}

export function createMemoryEventStore(
  isSessionPinned: (sessionId: string) => boolean,
  maxCachedSessions: number = DEFAULT_MAX_CACHED_SESSIONS,
  maxEventsPerSession: number = DEFAULT_MAX_EVENTS_PER_SESSION,
  maxStringFieldSize: number = DEFAULT_MAX_STRING_SIZE,
): EventStore {
  const buffers = new Map<string, SessionBuffer>();
  let totalBytes = 0;

  function getOrCreate(sessionId: string): SessionBuffer {
    let buf = buffers.get(sessionId);
    if (!buf) {
      buf = { events: [], nextSeq: 1, lastAccess: Date.now(), bytesRetained: 0 };
      buffers.set(sessionId, buf);
    }
    buf.lastAccess = Date.now();
    return buf;
  }

  function evictIfNeeded(): void {
    if (buffers.size <= maxCachedSessions) return;

    // Collect evictable sessions sorted by lastAccess ascending
    const evictable: Array<[string, number]> = [];
    for (const [id, buf] of buffers) {
      if (!isSessionPinned(id)) {
        evictable.push([id, buf.lastAccess]);
      }
    }
    evictable.sort((a, b) => a[1] - b[1]);

    // Evict until we're at or below the limit
    let toEvict = buffers.size - maxCachedSessions;
    for (const [id] of evictable) {
      if (toEvict <= 0) break;
      const buf = buffers.get(id);
      if (buf) totalBytes -= buf.bytesRetained;
      buffers.delete(id);
      toEvict--;
    }
  }

  return {
    insertEvent(sessionId: string, event: DashboardEvent): number {
      const buf = getOrCreate(sessionId);
      const seq = buf.nextSeq++;
      const { event: sanitized, bytes } = sanitizeEvent(event, maxStringFieldSize);
      buf.events.push({ seq, event: sanitized, bytes });
      buf.bytesRetained += bytes;
      totalBytes += bytes;
      // Trim oldest events when over the per-session limit (0 = unlimited)
      if (maxEventsPerSession > 0 && buf.events.length > maxEventsPerSession) {
        const excess = buf.events.length - maxEventsPerSession;
        const removed = buf.events.splice(0, excess);
        for (const r of removed) {
          buf.bytesRetained -= r.bytes;
          totalBytes -= r.bytes;
        }
      }
      evictIfNeeded();
      return seq;
    },

    getEvents(sessionId: string, minSeq: number): StoredEvent[] {
      const buf = buffers.get(sessionId);
      if (!buf) return [];
      buf.lastAccess = Date.now();
      const effectiveMin = minSeq > 0 ? minSeq : 1;
      return buf.events.filter((e) => e.seq >= effectiveMin);
    },

    getEvent(sessionId: string, seq: number): DashboardEvent | undefined {
      const buf = buffers.get(sessionId);
      if (!buf) return undefined;
      buf.lastAccess = Date.now();
      const entry = buf.events.find((e) => e.seq === seq);
      return entry?.event;
    },

    deleteEventsForSession(sessionId: string): number {
      const buf = buffers.get(sessionId);
      if (!buf) return 0;
      const count = buf.events.length;
      totalBytes -= buf.bytesRetained;
      buffers.delete(sessionId);
      return count;
    },

    hasEvents(sessionId: string): boolean {
      const buf = buffers.get(sessionId);
      return buf !== undefined && buf.events.length > 0;
    },

    getMaxSeq(sessionId: string): number {
      const buf = buffers.get(sessionId);
      if (!buf || buf.events.length === 0) return 0;
      return buf.events[buf.events.length - 1].seq;
    },

    sessionCount(): number {
      return buffers.size;
    },

    bytesRetained(): number {
      return totalBytes;
    },

    sessionBytes(sessionId: string): number {
      return buffers.get(sessionId)?.bytesRetained ?? 0;
    },
  };
}
