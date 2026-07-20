/**
 * Ledger keyset-range tests — M6: order by (thread_id, numeric_seq), NEVER ts;
 * hand-off lane empty until the A4 verb lands (graceful-degrade).
 */
import { describe, it, expect } from "vitest";

import {
  HANDOFF_CHANGE_TYPE,
  isHandoffEvent,
  keysetRange,
  parseLedgerSeq,
  selectHandoffLane,
  withNumericSeq,
  type LedgerEvent,
} from "../ledger-range.js";

/** Build a ledger event; numeric_seq auto-derives from event_id unless given. */
function ev(over: Partial<LedgerEvent> & { event_id: string; thread_id: string }): LedgerEvent {
  const numeric_seq = over.numeric_seq ?? parseLedgerSeq(over.event_id) ?? -1;
  return {
    type: "decision-ledger-checkpoint",
    ts: "2026-07-20T00:00:00Z",
    summary: "s",
    status: "info",
    payload: "{}",
    parent_event_id: null,
    numeric_seq,
    ...over,
  };
}

describe("parseLedgerSeq", () => {
  it("parses dl-N to N", () => {
    expect(parseLedgerSeq("dl-1")).toBe(1);
    expect(parseLedgerSeq("dl-10438")).toBe(10438);
    expect(parseLedgerSeq("dl-0")).toBe(0);
  });
  it("rejects malformed ids (null, never a fabricated seq)", () => {
    expect(parseLedgerSeq("dl-")).toBeNull();
    expect(parseLedgerSeq("dl-1.5")).toBeNull();
    expect(parseLedgerSeq("dl--1")).toBeNull();
    expect(parseLedgerSeq("dl-1a")).toBeNull();
    expect(parseLedgerSeq("evt-3")).toBeNull();
    expect(parseLedgerSeq("")).toBeNull();
    expect(parseLedgerSeq("dl-99999999999999999999")).toBeNull(); // > safe int
  });
});

describe("withNumericSeq", () => {
  it("attaches numeric_seq and drops malformed ids", () => {
    const rows = [
      { event_id: "dl-3", thread_id: "t", type: "x", ts: "z", summary: "", status: "info" as const, payload: "{}", parent_event_id: null },
      { event_id: "bogus", thread_id: "t", type: "x", ts: "z", summary: "", status: "info" as const, payload: "{}", parent_event_id: null },
      { event_id: "dl-7", thread_id: "t", type: "x", ts: "z", summary: "", status: "info" as const, payload: "{}", parent_event_id: null },
    ];
    const out = withNumericSeq(rows);
    expect(out.map((e) => e.numeric_seq)).toEqual([3, 7]);
  });
});

describe("keysetRange — order by numeric_seq, never ts", () => {
  it("orders by numeric_seq ASC even when ts regresses (clock adjust / backfill)", () => {
    // ts goes BACKWARD as numeric_seq goes forward — ordering must follow seq.
    const events = [
      ev({ event_id: "dl-2", thread_id: "t", ts: "2026-07-20T10:00:00Z" }),
      ev({ event_id: "dl-3", thread_id: "t", ts: "2026-07-20T09:00:00Z" }), // earlier ts, later seq
      ev({ event_id: "dl-1", thread_id: "t", ts: "2026-07-20T11:00:00Z" }), // latest ts, earliest seq
    ];
    const out = keysetRange(events, { thread_id: "t" });
    expect(out.map((e) => e.event_id)).toEqual(["dl-1", "dl-2", "dl-3"]);
  });

  it("filters to the thread_id", () => {
    const events = [
      ev({ event_id: "dl-1", thread_id: "a" }),
      ev({ event_id: "dl-2", thread_id: "b" }),
      ev({ event_id: "dl-3", thread_id: "a" }),
    ];
    expect(keysetRange(events, { thread_id: "a" }).map((e) => e.event_id)).toEqual(["dl-1", "dl-3"]);
  });

  it("applies the exclusive afterSeq cursor", () => {
    const events = [
      ev({ event_id: "dl-1", thread_id: "t" }),
      ev({ event_id: "dl-2", thread_id: "t" }),
      ev({ event_id: "dl-3", thread_id: "t" }),
    ];
    expect(keysetRange(events, { thread_id: "t", afterSeq: 1 }).map((e) => e.numeric_seq)).toEqual([2, 3]);
    expect(keysetRange(events, { thread_id: "t", afterSeq: 3 })).toEqual([]);
  });

  it("caps at limit (after ordering)", () => {
    const events = [
      ev({ event_id: "dl-3", thread_id: "t" }),
      ev({ event_id: "dl-1", thread_id: "t" }),
      ev({ event_id: "dl-2", thread_id: "t" }),
    ];
    expect(keysetRange(events, { thread_id: "t", limit: 2 }).map((e) => e.numeric_seq)).toEqual([1, 2]);
    expect(keysetRange(events, { thread_id: "t", limit: 0 })).toEqual([]);
  });

  it("ordering is STABLE under a backfill insert (new low seq slots in place)", () => {
    const before = [
      ev({ event_id: "dl-10", thread_id: "t" }),
      ev({ event_id: "dl-20", thread_id: "t" }),
    ];
    const afterBackfill = [
      ...before,
      ev({ event_id: "dl-15", thread_id: "t", ts: "1999-01-01T00:00:00Z" }), // backfilled, ancient ts
    ];
    expect(keysetRange(afterBackfill, { thread_id: "t" }).map((e) => e.numeric_seq)).toEqual([10, 15, 20]);
  });

  it("excludes malformed (negative) numeric_seq", () => {
    const events = [
      ev({ event_id: "dl-5", thread_id: "t" }),
      ev({ event_id: "bad", thread_id: "t", numeric_seq: -1 }),
    ];
    expect(keysetRange(events, { thread_id: "t" }).map((e) => e.event_id)).toEqual(["dl-5"]);
  });
});

describe("selectHandoffLane — empty until the A4 verb lands", () => {
  it("empty thread → empty lane (graceful-degrade)", () => {
    expect(selectHandoffLane([], { thread_id: "t" })).toEqual([]);
  });

  it("a thread with only non-handoff events → empty lane (no fabrication)", () => {
    // This is TODAY: the ledger has checkpoints etc. but 0 thread-holder-change.
    const events = [
      ev({ event_id: "dl-1", thread_id: "t", type: "decision-ledger-checkpoint" }),
      ev({ event_id: "dl-2", thread_id: "t", type: "wstep-decision" }),
    ];
    expect(selectHandoffLane(events, { thread_id: "t" })).toEqual([]);
  });

  it("once the A4 verb lands, hand-off events appear in seq order", () => {
    const events = [
      ev({ event_id: "dl-1", thread_id: "t", type: "decision-ledger-checkpoint" }),
      ev({ event_id: "dl-4", thread_id: "t", type: HANDOFF_CHANGE_TYPE }),
      ev({ event_id: "dl-2", thread_id: "t", type: HANDOFF_CHANGE_TYPE }),
    ];
    const lane = selectHandoffLane(events, { thread_id: "t" });
    expect(lane.map((e) => e.numeric_seq)).toEqual([2, 4]);
    expect(lane.every(isHandoffEvent)).toBe(true);
  });

  it("HANDOFF_CHANGE_TYPE is the frozen A4 verb name", () => {
    expect(HANDOFF_CHANGE_TYPE).toBe("thread-holder-change");
  });
});
