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
}

interface SessionBuffer {
  events: StoredEvent[];
  nextSeq: number;
  lastAccess: number;
}

export const DEFAULT_MAX_CACHED_SESSIONS = 100;
export const DEFAULT_MAX_EVENTS_PER_SESSION = 5000;

/** Default max size for any string field within event data */
const DEFAULT_MAX_STRING_SIZE = 4_000;
/**
 * Max total serialized size for an individual event's data.
 * Raised from dead 20_000 → 30_000 per cell dashboard-memory-pressure-fix/v1
 * W2 design-pass (Pete-recommended 20–50KB middle). Now enforced via post-walk
 * gate + summarizeOversizedEvent fallback (was previously a dead constant).
 */
const MAX_EVENT_DATA_SIZE = 30_000;
/** Keys whose string values are stripped (with size annotation) when ≥ threshold. */
const RAW_CONTENT_KEYS = new Set(["raw_content", "rawContent"]);
const RAW_CONTENT_STRIP_THRESHOLD = 500;

/**
 * Recursively truncate large string fields in an object.
 * Returns a new object if any truncation occurred, otherwise the original.
 *
 * Per cell dashboard-memory-pressure-fix/v1 W2 design-pass: depth-limit
 * removed; walk bounded by createTruncator's post-walk total-cap gate. Adds
 * key-aware raw_content/rawContent strip. Preserves invariants I1
 * (image-preservation) + thinking carve-out verbatim.
 */
function truncateStrings(obj: unknown, maxSize: number): unknown {
  if (typeof obj === "string") {
    return obj.length > maxSize ? obj.slice(0, maxSize) + "\n…[truncated]" : obj;
  }
  if (Array.isArray(obj)) {
    // Skip large arrays (e.g., edits arrays)
    if (obj.length > 20) return "[array truncated]";
    let changed = false;
    const result = obj.map((item) => {
      const t = truncateStrings(item, maxSize);
      if (t !== item) changed = true;
      return t;
    });
    return changed ? result : obj;
  }
  if (obj && typeof obj === "object") {
    let changed = false;
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      // Carve-out 1 — image-preservation (invariant I1; UNCHANGED).
      // Preserve base64 image data — skip truncation when sibling mimeType exists.
      if (key === "data" && typeof val === "string" && "mimeType" in obj) {
        result[key] = val;
        continue;
      }
      // Carve-out 2 — thinking cap (UNCHANGED, 500 char).
      if (key === "thinking" && typeof val === "string" && val.length > maxSize) {
        result[key] = (val as string).slice(0, 500) + "\n…[truncated]";
        changed = true;
        continue;
      }
      // Carve-out 3 (NEW) — strip-by-name raw_content / rawContent ≥ 500B.
      // Targets the Tavily/MCP search-result payload pattern empirically
      // observed in Pete-evidence-bundle AFR line 130 (~108KB × 6 results).
      if (
        RAW_CONTENT_KEYS.has(key) &&
        typeof val === "string" &&
        val.length >= RAW_CONTENT_STRIP_THRESHOLD
      ) {
        result[key] = `[raw_content stripped: ${val.length} bytes]`;
        changed = true;
        continue;
      }
      const t = truncateStrings(val, maxSize);
      if (t !== val) changed = true;
      result[key] = t;
    }
    return changed ? result : obj;
  }
  return obj;
}

/**
 * Fallback shape when total-cap gate fires. Preserves UI-required fields per
 * cell dashboard-memory-pressure-fix/v1 W2 design-pass invariant I4:
 * toolCallId, toolName, isError, entryId, result (1.5KB slice), images (I1
 * composition), message.role + message.content text-summary (2KB slice),
 * type discriminant. Adds __summary marker with originalSize + cap.
 */
function summarizeOversizedEvent(
  event: DashboardEvent,
  truncated: Record<string, unknown>,
  originalSize: number,
): DashboardEvent {
  const d = truncated as Record<string, unknown>;
  const summary: Record<string, unknown> = {
    type: d.type,
    __summary: { originalSize, cap: MAX_EVENT_DATA_SIZE },
  };
  for (const k of ["toolCallId", "toolName", "isError", "entryId"]) {
    if (k in d) summary[k] = d[k];
  }
  if (typeof d.result === "string") {
    summary.result = (d.result as string).slice(0, 1_500) + "\n…[truncated]";
  }
  if (d.images) summary.images = d.images; // I1 composition
  if (d.message && typeof d.message === "object") {
    const m = d.message as { role?: unknown; content?: unknown };
    let text = "";
    if (Array.isArray(m.content)) {
      text = (m.content as Array<{ type?: string; text?: string }>)
        .filter((c) => c?.type === "text")
        .map((c) => c.text ?? "")
        .join("");
    } else if (typeof m.content === "string") {
      text = m.content;
    }
    summary.message = {
      role: m.role,
      content:
        text.slice(0, 2_000) + (text.length > 2_000 ? "\n…[truncated]" : ""),
    };
  }
  return { ...event, data: summary } as DashboardEvent;
}

/**
 * Truncate large event data to bound memory usage per event.
 * Post-walk total-cap gate enforces MAX_EVENT_DATA_SIZE; on cap-exceed,
 * event is replaced with summarizeOversizedEvent shape (invariant I4).
 */
function createTruncator(maxStringSize: number) {
  if (maxStringSize <= 0) return (event: DashboardEvent) => event; // disabled
  return (event: DashboardEvent): DashboardEvent => {
    const data = event.data;
    if (!data || typeof data !== "object") return event;
    const truncated = truncateStrings(data, maxStringSize) as Record<string, unknown>;
    const out = truncated !== data ? { ...event, data: truncated } : event;
    // Post-walk total-cap gate (invariant I4).
    const size = JSON.stringify(out.data).length;
    if (size > MAX_EVENT_DATA_SIZE) {
      return summarizeOversizedEvent(out, truncated, size);
    }
    return out;
  };
}

export function createMemoryEventStore(
  isSessionPinned: (sessionId: string) => boolean,
  maxCachedSessions: number = DEFAULT_MAX_CACHED_SESSIONS,
  maxEventsPerSession: number = DEFAULT_MAX_EVENTS_PER_SESSION,
  maxStringFieldSize: number = DEFAULT_MAX_STRING_SIZE,
): EventStore {
  const truncateEventData = createTruncator(maxStringFieldSize);
  const buffers = new Map<string, SessionBuffer>();

  function getOrCreate(sessionId: string): SessionBuffer {
    let buf = buffers.get(sessionId);
    if (!buf) {
      buf = { events: [], nextSeq: 1, lastAccess: Date.now() };
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
      buffers.delete(id);
      toEvict--;
    }
  }

  return {
    insertEvent(sessionId: string, event: DashboardEvent): number {
      const buf = getOrCreate(sessionId);
      const seq = buf.nextSeq++;
      buf.events.push({ seq, event: truncateEventData(event) });
      // Trim oldest events when over the per-session limit (0 = unlimited)
      if (maxEventsPerSession > 0 && buf.events.length > maxEventsPerSession) {
        const excess = buf.events.length - maxEventsPerSession;
        buf.events.splice(0, excess);
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
  };
}
