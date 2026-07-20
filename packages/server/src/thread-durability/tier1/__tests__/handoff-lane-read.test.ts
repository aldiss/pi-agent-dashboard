/**
 * Hand-off-lane reader tests — graceful-degrade (absent db / throwing source /
 * no hand-off events all → empty lane), plus a real node:sqlite round-trip
 * proving the indexed keyset SELECT reads the ACTIVE v2 schema correctly.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { HANDOFF_CHANGE_TYPE } from "@blackbelt-technology/pi-dashboard-shared/thread-durability/tier1/ledger-range.js";
import {
  readHandoffLane,
  createSqliteLedgerSource,
  type LedgerRowSource,
  type RawLedgerRow,
} from "../handoff-lane-read.js";

const _require = createRequire(import.meta.url);
/** Is the experimental node:sqlite runtime present? (skip the round-trip if not) */
function sqliteAvailable(): boolean {
  try {
    _require("node:sqlite");
    return true;
  } catch {
    return false;
  }
}

function raw(over: Partial<RawLedgerRow> & { event_id: string; thread_id: string }): RawLedgerRow {
  return {
    type: "decision-ledger-checkpoint",
    ts: "2026-07-20T00:00:00Z",
    summary: "s",
    status: "info",
    payload: "{}",
    parent_event_id: null,
    ...over,
  };
}

describe("readHandoffLane — graceful-degrade over an injected source", () => {
  it("a throwing source (absent db / mid-build) → empty lane", () => {
    const source: LedgerRowSource = {
      readThreadRows() {
        throw new Error("SQLITE_CANTOPEN: no such file");
      },
    };
    expect(readHandoffLane(source, { thread_id: "t" })).toEqual([]);
  });

  it("a thread with no hand-off events → empty lane (today's reality)", () => {
    const source: LedgerRowSource = {
      readThreadRows: () => [
        raw({ event_id: "dl-1", thread_id: "t", type: "decision-ledger-checkpoint" }),
        raw({ event_id: "dl-2", thread_id: "t", type: "wstep-decision" }),
      ],
    };
    expect(readHandoffLane(source, { thread_id: "t" })).toEqual([]);
  });

  it("returns hand-off events in numeric_seq order once they exist", () => {
    const source: LedgerRowSource = {
      readThreadRows: () => [
        raw({ event_id: "dl-9", thread_id: "t", type: HANDOFF_CHANGE_TYPE, summary: "handoff B" }),
        raw({ event_id: "dl-4", thread_id: "t", type: HANDOFF_CHANGE_TYPE, summary: "handoff A" }),
        raw({ event_id: "dl-6", thread_id: "t", type: "decision-ledger-checkpoint" }),
      ],
    };
    const lane = readHandoffLane(source, { thread_id: "t" });
    expect(lane.map((e) => e.numeric_seq)).toEqual([4, 9]);
    expect(lane.map((e) => e.summary)).toEqual(["handoff A", "handoff B"]);
  });

  it("honors the keyset afterSeq + limit on the hand-off lane", () => {
    const source: LedgerRowSource = {
      readThreadRows: () =>
        [2, 4, 6, 8].map((n) =>
          raw({ event_id: `dl-${n}`, thread_id: "t", type: HANDOFF_CHANGE_TYPE }),
        ),
    };
    expect(readHandoffLane(source, { thread_id: "t", afterSeq: 4, limit: 1 }).map((e) => e.numeric_seq)).toEqual([6]);
  });
});

describe("createSqliteLedgerSource — real node:sqlite round-trip", () => {
  it.runIf(sqliteAvailable())("reads hand-off rows from a real v2-schema db via the indexed keyset", () => {
    const sqlite = _require("node:sqlite") as typeof import("node:sqlite");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tier1-ledger-"));
    const dbPath = path.join(dir, "decision-ledger-v2.db");
    try {
      // Build a minimal but FAITHFUL v2 `events` table (the columns the reader
      // selects + the CHECK constraints from the live schema).
      const db = new sqlite.DatabaseSync(dbPath);
      db.exec(`CREATE TABLE events (
        event_id TEXT PRIMARY KEY NOT NULL,
        ts TEXT NOT NULL,
        type TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        host TEXT NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 2,
        fingerprint TEXT NOT NULL,
        source TEXT,
        summary TEXT NOT NULL CHECK (length(trim(summary)) > 0),
        status TEXT NOT NULL CHECK (status IN ('open','closed','info')),
        parent_event_id TEXT REFERENCES events(event_id),
        closes TEXT REFERENCES events(event_id),
        payload TEXT NOT NULL,
        migrated INTEGER NOT NULL DEFAULT 0
      );`);
      db.exec(`CREATE INDEX idx_events_thread ON events(thread_id);`);
      const ins = db.prepare(
        `INSERT INTO events (event_id, ts, type, thread_id, host, fingerprint, summary, status, payload)
         VALUES (?, ?, ?, ?, 'macbook', 'sha256:x', ?, ?, ?)`,
      );
      // Two hand-off events (seq 3, 12) + noise on this + another thread.
      ins.run("dl-3", "2026-07-20T10:00:00Z", HANDOFF_CHANGE_TYPE, "th", "handoff one", "info", "{}");
      ins.run("dl-7", "2026-07-20T09:00:00Z", "decision-ledger-checkpoint", "th", "noise", "info", "{}");
      ins.run("dl-12", "2026-07-20T08:00:00Z", HANDOFF_CHANGE_TYPE, "th", "handoff two", "info", "{}"); // earlier ts, later seq
      ins.run("dl-5", "2026-07-20T10:00:00Z", HANDOFF_CHANGE_TYPE, "other", "other-thread", "info", "{}");
      db.close();

      const source = createSqliteLedgerSource({ dbPath });
      const lane = readHandoffLane(source, { thread_id: "th" });
      // Ordered by numeric_seq (3, 12) NOT ts (which would give 12, 3).
      expect(lane.map((e) => e.event_id)).toEqual(["dl-3", "dl-12"]);
      expect(lane.map((e) => e.summary)).toEqual(["handoff one", "handoff two"]);
      // The other thread's hand-off is excluded.
      expect(readHandoffLane(source, { thread_id: "other" }).map((e) => e.event_id)).toEqual(["dl-5"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an absent db path degrades to an empty lane (no throw)", () => {
    const source = createSqliteLedgerSource({ dbPath: "/nonexistent/decision-ledger-v2.db" });
    expect(readHandoffLane(source, { thread_id: "th" })).toEqual([]);
  });
});
