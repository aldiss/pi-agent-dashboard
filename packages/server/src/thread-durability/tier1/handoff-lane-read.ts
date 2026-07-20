/**
 * Tier-1 read-only visibility — the server-side hand-off-lane reader (design
 * v0.3 Tier-1 §"What Tier-1 IS" #3, the hand-off lane; M6).
 *
 * Binds the pure keyset logic (`ledger-range.ts`) to a read-only row source
 * over the ACTIVE `decision-ledger-v2` SQLite db. The v2 CLI has NO
 * keyset-range verb (only `get <event_id>` + `open-set`), so per the spec this
 * is the "small read-only indexed range helper" — a single indexed SELECT over
 * the `idx_events_thread` index, ordered by the monotonic `numeric_seq`.
 *
 * READ-ONLY, and hard: the db is opened `readOnly:true`; the reader issues one
 * parameterized SELECT; it NEVER writes, NEVER runs the write-gated CLI, NEVER
 * touches the v1 mirror. It is an ADDITIVE read over an existing store.
 *
 * GRACEFUL DEGRADE is total: an absent db (the ledger not present in this
 * environment — 0 hits is normal today), a missing `node:sqlite` runtime, a
 * read/parse error, or a thread with no hand-off events ALL resolve to an EMPTY
 * lane. The hand-off lane is empty until the A4 `thread-holder-change` verb
 * lands anyway — an empty lane is the correct, honest Tier-1 output, never a
 * fabricated row and never a thrown error bubbling into the read path.
 *
 * NOT WIRED: this reader is built + tested standalone. It does NOT wire
 * `server.ts` (activation-tier), and the default SQLite source is opt-in — the
 * `node:sqlite` import is lazy so merely importing this module never triggers
 * the experimental-SQLite warning.
 */

import { createRequire } from "node:module";

import {
  selectHandoffLane,
  withNumericSeq,
  HANDOFF_CHANGE_TYPE,
  type LedgerEvent,
  type LedgerKeysetQuery,
} from "@blackbelt-technology/pi-dashboard-shared/thread-durability/tier1/ledger-range.js";

/**
 * ESM-safe synchronous lazy loader (repo convention — cf.
 * `provider-auth-storage.ts`, `push-vapid.ts`). `node:sqlite`'s `DatabaseSync`
 * is a synchronous API, so a sync `require` keeps the `readThreadRows` seam
 * synchronous. Resolved lazily inside the reader so importing this module is
 * side-effect-free (no experimental-SQLite warning until a read is attempted).
 */
const _require = createRequire(import.meta.url);

/**
 * A raw ledger row as read from the v2 `events` table (before `numeric_seq` is
 * parsed). The `event_id` carries the monotonic `dl-N` the keyset derives from.
 */
export type RawLedgerRow = Omit<LedgerEvent, "numeric_seq">;

/**
 * The read-only row source seam. `readThreadRows` returns EVERY ledger row for
 * one thread (the indexed lookup); the keyset ordering + hand-off filtering is
 * applied in pure code on top. A missing/absent source returns `[]`. Injected
 * so tests need no real SQLite db and the reader stays graceful-degrade.
 */
export interface LedgerRowSource {
  readThreadRows(thread_id: string): RawLedgerRow[];
}

/**
 * Read a thread's HAND-OFF LANE (read-only): pull the thread's rows from the
 * source, parse `numeric_seq` (dropping malformed ids), apply the keyset range
 * + `thread-holder-change` filter (pure). Any source throw → an EMPTY lane
 * (graceful-degrade — never propagates an I/O failure into the read path).
 */
export function readHandoffLane(
  source: LedgerRowSource,
  query: LedgerKeysetQuery,
): LedgerEvent[] {
  let raw: RawLedgerRow[];
  try {
    raw = source.readThreadRows(query.thread_id);
  } catch {
    return []; // absent db / read error / mid-build → empty lane
  }
  const events = withNumericSeq(raw);
  return selectHandoffLane(events, query);
}

/**
 * Options for the default SQLite-backed row source. `dbPath` defaults to the
 * canonical v2 db location; override for tests/isolation (mirrors the ledger
 * CLI's `LEDGER_V2_DB` env discipline).
 */
export interface SqliteLedgerSourceOptions {
  /** Absolute path to the `decision-ledger-v2.db` SQLite file. */
  dbPath: string;
  /**
   * Optional cap on rows pulled per thread by the indexed SELECT (a perf belt
   * on a hot thread; the keyset `limit` still applies on top). Default 10000.
   */
  maxRowsPerThread?: number;
}

/**
 * Build the default read-only SQLite row source over the v2 ledger. Uses
 * `node:sqlite` (Node 22.5+) opened `readOnly:true`, a single parameterized
 * SELECT on the `idx_events_thread` index ordered by the monotonic sequence
 * (`CAST(SUBSTR(event_id,4) AS INTEGER)` — the same expression the ledger's own
 * `resolve_next_id` uses).
 *
 * FAILURE-ISOLATED: the `node:sqlite` import + the db open + the query are ALL
 * guarded — an absent db, a missing runtime, or a query error yields a source
 * whose `readThreadRows` returns `[]`. The import is LAZY (inside
 * `readThreadRows`), so importing this module is side-effect-free and never
 * emits the experimental-SQLite warning until a read is actually attempted.
 *
 * NOTE: `readThreadRows` is synchronous per the seam; `node:sqlite`'s
 * `DatabaseSync` is a synchronous API, so no async leaks into the read path.
 * The DB handle is opened once (lazily) and reused across reads.
 */
export function createSqliteLedgerSource(opts: SqliteLedgerSourceOptions): LedgerRowSource {
  const maxRows = opts.maxRowsPerThread ?? 10_000;
  // Lazily-resolved prepared-statement holder. `false` = not yet tried;
  // `null` = tried and unavailable (degrade to empty); object = ready.
  let db: { query(thread_id: string, cap: number): RawLedgerRow[] } | null | false = false;

  function ensureDb(): { query(thread_id: string, cap: number): RawLedgerRow[] } | null {
    if (db !== false) return db;
    try {
      // Lazy require of the experimental synchronous SQLite API. Wrapped so a
      // runtime without `node:sqlite` degrades to an empty lane, not a crash.
      const sqlite = _require("node:sqlite") as typeof import("node:sqlite");
      const handle = new sqlite.DatabaseSync(opts.dbPath, { readOnly: true });
      const stmt = handle.prepare(
        `SELECT event_id, thread_id, type, ts, summary, status, payload, parent_event_id
           FROM events
          WHERE thread_id = ?
          ORDER BY CAST(SUBSTR(event_id, 4) AS INTEGER) ASC
          LIMIT ?`,
      );
      db = {
        query(thread_id: string, cap: number): RawLedgerRow[] {
          const rows = stmt.all(thread_id, cap) as Array<Record<string, unknown>>;
          return rows.map((r) => ({
            event_id: String(r.event_id),
            thread_id: String(r.thread_id),
            type: String(r.type),
            ts: String(r.ts),
            summary: String(r.summary ?? ""),
            status: (r.status as RawLedgerRow["status"]) ?? "info",
            payload: String(r.payload ?? ""),
            parent_event_id: (r.parent_event_id as string | null) ?? null,
          }));
        },
      };
    } catch {
      db = null; // absent db / no node:sqlite / open failure → degrade
    }
    return db;
  }

  return {
    readThreadRows(thread_id: string): RawLedgerRow[] {
      const ready = ensureDb();
      if (ready === null) return [];
      try {
        return ready.query(thread_id, maxRows);
      } catch {
        return []; // query-time failure → empty lane
      }
    },
  };
}

/** Re-export the hand-off verb constant for server call sites. */
export { HANDOFF_CHANGE_TYPE };
