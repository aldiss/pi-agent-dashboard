/**
 * Tier-1 read-only visibility — the v2-ledger keyset range logic for the
 * hand-off lane (design v0.3 Tier-1 §"Round-2 read-side corrections" M6).
 *
 * PURE keyset math over ledger events — no SQLite, no I/O (the row source is
 * injected server-side in `handoff-lane-read.ts`). Two frozen decisions the
 * round-2 teardown pinned:
 *
 *  1. **Keyset by `(thread_id, numeric_seq)`, NEVER `(thread_id, ts)`.** The v2
 *     ledger's `ts` is a wall-clock UTC stamp that CAN GO BACKWARD under a clock
 *     adjustment or a backfill/migration insert; ordering the hand-off lane by
 *     `ts` would shuffle events under those conditions. The monotonic `dl-N`
 *     counter is the stable order — `numeric_seq` = the integer `N` in `dl-N`
 *     (`event_id`), matching the ledger's own `resolve_next_id`
 *     (`MAX(CAST(SUBSTR(event_id,4) AS INTEGER))`).
 *
 *  2. **The ACTIVE `decision-ledger-v2` (SQLite), NOT the v1-legacy `.jsonl`**
 *     (which restarts `dl-1` after `dl-1245`, so its ids are NOT globally
 *     monotonic). This module is agnostic to the byte source, but the server
 *     reader binds it to the v2 SQLite db — never the v1 mirror as an id source.
 *
 * The hand-off lane is EMPTY until the A4 `thread-holder-change` verb lands
 * (grep = 0 in the ledger today) → `selectHandoffLane` graceful-degrades to an
 * empty array, never fabricates a holder-change row.
 */

/**
 * A read-only ledger event row (the subset the hand-off lane consults). Mirrors
 * the v2 `events` table columns; `numeric_seq` is the parsed integer form of
 * `event_id`'s `dl-N` for keyset ordering.
 */
export interface LedgerEvent {
  event_id: string; // dl-<N>
  numeric_seq: number; // N (parsed from event_id)
  thread_id: string;
  type: string;
  ts: string; // wall-clock UTC — NOT used for ordering (may regress)
  summary: string;
  status: "open" | "closed" | "info";
  payload: string; // compact JSON blob (opaque here)
  parent_event_id?: string | null;
}

/** A keyset range query over one thread's events, ordered by numeric_seq. */
export interface LedgerKeysetQuery {
  thread_id: string;
  /**
   * Exclusive lower bound on `numeric_seq` (the keyset cursor). Return only
   * events with `numeric_seq > afterSeq`. Omit / undefined = from the start.
   */
  afterSeq?: number;
  /** Max rows to return (after ordering). Omit = no cap. */
  limit?: number;
}

/** The canonical A4 hand-off verb — the ledger `type` for a holder change. */
export const HANDOFF_CHANGE_TYPE = "thread-holder-change" as const;

/**
 * Parse the monotonic `numeric_seq` from a `dl-N` event id. Returns null for a
 * malformed id (no `dl-` prefix / non-integer tail) — a malformed id is NOT
 * assigned a fabricated sequence; the caller drops it from the keyset.
 */
export function parseLedgerSeq(eventId: string): number | null {
  if (!eventId.startsWith("dl-")) return null;
  const tail = eventId.slice(3);
  // Strict integer: digits only (no signs, no floats, no whitespace).
  if (!/^\d+$/.test(tail)) return null;
  const n = Number.parseInt(tail, 10);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Attach `numeric_seq` to a raw row lacking it, parsing from `event_id`. Rows
 * with a malformed id are dropped (null seq → no stable order → excluded).
 * Pure; does not mutate the input rows.
 */
export function withNumericSeq(
  rows: readonly Omit<LedgerEvent, "numeric_seq">[],
): LedgerEvent[] {
  const out: LedgerEvent[] = [];
  for (const r of rows) {
    const numeric_seq = parseLedgerSeq(r.event_id);
    if (numeric_seq === null) continue;
    out.push({ ...r, numeric_seq });
  }
  return out;
}

/**
 * Apply the keyset range to a set of events (pure): filter to the thread, drop
 * everything at/below the `afterSeq` cursor, order by `numeric_seq` ASC
 * (STABLE, monotonic — never by `ts`), then cap at `limit`.
 *
 * `numeric_seq` is globally unique in the v2 ledger (one monotonic counter), so
 * the ASC order is total and deterministic — no tie-break needed. Events whose
 * `numeric_seq` is NaN/negative are treated as malformed and excluded.
 */
export function keysetRange(
  events: readonly LedgerEvent[],
  query: LedgerKeysetQuery,
): LedgerEvent[] {
  const after = query.afterSeq;
  const filtered = events.filter(
    (e) =>
      e.thread_id === query.thread_id &&
      Number.isSafeInteger(e.numeric_seq) &&
      e.numeric_seq >= 0 &&
      (after === undefined || e.numeric_seq > after),
  );
  filtered.sort((a, b) => a.numeric_seq - b.numeric_seq);
  if (query.limit !== undefined && query.limit >= 0) {
    return filtered.slice(0, query.limit);
  }
  return filtered;
}

/** True iff a ledger event is an A4 hand-off (`thread-holder-change`). */
export function isHandoffEvent(e: LedgerEvent): boolean {
  return e.type === HANDOFF_CHANGE_TYPE;
}

/**
 * Select the HAND-OFF LANE for a thread: the keyset range narrowed to
 * `thread-holder-change` events, in monotonic `numeric_seq` order. Empty until
 * the A4 verb lands (graceful-degrade — an empty array, never a fabricated
 * row). This is the pure lane projection; the server reader supplies the rows.
 */
export function selectHandoffLane(
  events: readonly LedgerEvent[],
  query: LedgerKeysetQuery,
): LedgerEvent[] {
  return keysetRange(events, query).filter(isHandoffEvent);
}
