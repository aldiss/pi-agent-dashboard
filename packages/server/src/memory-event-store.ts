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
 * Recursively sanitize event data:
 *  - ALWAYS strip `raw_content` / `rawContent` at any depth (the nested
 *    MCP/Tavily web-page payloads are the load-bearing leak shape), regardless
 *    of whether per-string truncation is enabled. This is defense-in-depth: it
 *    holds even if `maxSize` is mis-configured back to 0.
 *  - When `maxSize > 0`: truncate over-long strings, elide oversized arrays,
 *    and shrink `thinking` blocks.
 *  - Preserve base64 image `data` when a sibling `mimeType` is present.
 *
 * Returns a new object/array if anything changed, otherwise the original.
 */
function deepSanitize(obj: unknown, maxSize: number, depth: number): unknown {
  if (depth > MAX_SANITIZE_DEPTH) return obj;

  if (typeof obj === "string") {
    if (maxSize > 0 && obj.length > maxSize) return obj.slice(0, maxSize) + "\n…[truncated]";
    return obj;
  }

  if (Array.isArray(obj)) {
    if (maxSize > 0 && obj.length > MAX_ARRAY_LENGTH) return `[array truncated: ${obj.length} items]`;
    let changed = false;
    const result = obj.map((item) => {
      const t = deepSanitize(item, maxSize, depth + 1);
      if (t !== item) changed = true;
      return t;
    });
    return changed ? result : obj;
  }

  if (obj && typeof obj === "object") {
    let changed = false;
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      // ALWAYS strip raw_content / rawContent — at any depth, any config.
      if (key === "raw_content" || key === "rawContent") {
        result[key] = strippedMarker(val);
        changed = true;
        continue;
      }
      // Preserve base64 image data — skip truncation when a sibling mimeType exists.
      if (key === "data" && typeof val === "string" && "mimeType" in obj) {
        result[key] = val;
        continue;
      }
      // Shrink 'thinking' blocks — large and not shown in chat.
      if (key === "thinking" && typeof val === "string" && maxSize > 0 && val.length > maxSize) {
        result[key] = val.slice(0, 500) + "\n…[truncated]";
        changed = true;
        continue;
      }
      const t = deepSanitize(val, maxSize, depth + 1);
      if (t !== val) changed = true;
      result[key] = t;
    }
    return changed ? result : obj;
  }

  return obj;
}

/**
 * Build a compact summary of an over-cap event's data, preserving the fields
 * the UI needs to render a row (tool identity, message role + a short text
 * preview). Used only when an event still exceeds MAX_EVENT_DATA_SIZE after
 * field-level sanitization.
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
    const preview = previewContent(m.content);
    if (preview !== undefined) msgSummary.content = preview;
    summary.message = msgSummary;
  }
  return summary;
}

/**
 * Sanitize an event and measure its retained serialized size.
 * Pipeline: deep field-level sanitize → hard total-byte cap backstop.
 * Always runs (raw_content strip + byte cap are unconditional); per-string
 * truncation is active only when `maxStringSize > 0`.
 */
function sanitizeEvent(
  event: DashboardEvent,
  maxStringSize: number,
): { event: DashboardEvent; bytes: number } {
  const data = event.data;
  if (!data || typeof data !== "object") {
    const s = safeStringify(data);
    return { event, bytes: s ? s.length : 0 };
  }

  const walked = deepSanitize(data, maxStringSize, 0) as Record<string, unknown>;
  const afterWalk = walked !== data ? { ...event, data: walked } : event;

  const serialized = safeStringify(afterWalk.data);
  if (serialized === null) {
    // Unserializable (cycle/BigInt) — replace with a minimal marker.
    const marker = { __truncated: true, __reason: "unserializable" };
    return { event: { ...afterWalk, data: marker }, bytes: safeStringify(marker)?.length ?? 0 };
  }
  if (serialized.length > MAX_EVENT_DATA_SIZE) {
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
