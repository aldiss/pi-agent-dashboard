/**
 * Tier-1 status-read tests — the ONE authoritative read (row → TerminalProof →
 * fail-loud), graceful-degrade to `building`, NEVER infers from history.
 */
import { describe, it, expect } from "vitest";

import type {
  DeliveryState,
  OutboxEntry,
} from "@blackbelt-technology/pi-dashboard-shared/thread-durability/index.js";
import {
  deriveDeliveryStatus,
  deriveThreadStatus,
  readThreadStatus,
  selectCurrentRow,
  type ThreadRowSource,
} from "../thread-status-read.js";

/** Build a well-formed durable row; override any field for the case at hand. */
function row(over: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    delivery_id: "d1",
    attempt: 0,
    thread_id: "t1",
    holder_session_id: "s1",
    holder_identity: { pid: 1, session_id: "s1", start_epoch: 1 },
    holder_epoch: 1,
    payload_hash: "h",
    state: "injecting",
    revision: 0,
    delivered: false,
    updated_at: 1000,
    ...over,
  };
}

describe("deriveDeliveryStatus — row → TerminalProof → fail-loud", () => {
  it("reads the delivered TerminalProof (delivered:true at executed)", () => {
    const s = deriveDeliveryStatus(row({ state: "executed", delivered: true, revision: 5 }));
    expect(s.kind).toBe("delivered");
    expect(s.state).toBe("executed");
    expect(s.revision).toBe(5);
    expect(s.reason).toBeUndefined();
  });

  it("reads a terminal failed claim", () => {
    const s = deriveDeliveryStatus(row({ state: "failed", revision: 2 }));
    expect(s.kind).toBe("failed");
    expect(s.state).toBe("failed");
  });

  it.each<DeliveryState>(["injecting", "queued_executing", "observed", "accepted"])(
    "maps non-terminal state %s → in_flight",
    (state) => {
      const s = deriveDeliveryStatus(row({ state }));
      expect(s.kind).toBe("in_flight");
      expect(s.state).toBe(state);
    },
  );

  it("maps executed-BEFORE-delivered → in_flight (barrier not yet crossed)", () => {
    // The committed store writes `executed` (markExecuted) BEFORE `delivered`
    // (markDelivered). Executed-without-barrier is still in motion, not done.
    const s = deriveDeliveryStatus(row({ state: "executed", delivered: false }));
    expect(s.kind).toBe("in_flight");
  });

  it("fail-loud on an unknown state (never coerced to a plausible status)", () => {
    const s = deriveDeliveryStatus(row({ state: "bogus" as DeliveryState }));
    expect(s.kind).toBe("corrupt");
    expect(s.reason).toBe("unknown_state");
  });

  it("fail-loud on delivered:true WITHOUT the executed terminal (corrupt barrier)", () => {
    const s = deriveDeliveryStatus(row({ state: "accepted", delivered: true }));
    expect(s.kind).toBe("corrupt");
    expect(s.reason).toBe("delivered_without_executed");
  });

  it("fail-loud on a negative / NaN revision", () => {
    expect(deriveDeliveryStatus(row({ revision: -1 })).reason).toBe("invalid_revision");
    expect(deriveDeliveryStatus(row({ revision: Number.NaN })).reason).toBe("invalid_revision");
  });

  it("fail-loud on a negative / NaN attempt", () => {
    expect(deriveDeliveryStatus(row({ attempt: -3 })).reason).toBe("invalid_attempt");
    expect(deriveDeliveryStatus(row({ attempt: Number.NaN })).reason).toBe("invalid_attempt");
  });
});

describe("selectCurrentRow — SELECT by committed field, never aggregate", () => {
  it("returns null for an empty set", () => {
    expect(selectCurrentRow([])).toBeNull();
  });

  it("picks the greatest updated_at", () => {
    const r = selectCurrentRow([
      row({ delivery_id: "a", updated_at: 10 }),
      row({ delivery_id: "b", updated_at: 30 }),
      row({ delivery_id: "c", updated_at: 20 }),
    ]);
    expect(r?.delivery_id).toBe("b");
  });

  it("breaks updated_at ties by delivery_id (deterministic)", () => {
    const r = selectCurrentRow([
      row({ delivery_id: "a", updated_at: 10 }),
      row({ delivery_id: "z", updated_at: 10 }),
      row({ delivery_id: "m", updated_at: 10 }),
    ]);
    expect(r?.delivery_id).toBe("z");
  });
});

describe("deriveThreadStatus — graceful degrade, never infer from history", () => {
  it("null rows (substrate absent / mid-build) → building/substrate_absent", () => {
    const s = deriveThreadStatus("t1", null);
    expect(s.kind).toBe("building");
    expect(s.reason).toBe("substrate_absent");
    expect(s.state).toBeUndefined();
  });

  it("empty rows (substrate present, no rows yet) → building/no_rows", () => {
    const s = deriveThreadStatus("t1", []);
    expect(s.kind).toBe("building");
    expect(s.reason).toBe("no_rows");
  });

  it("reads the CURRENT row's status only (does NOT infer from prior rows)", () => {
    // A prior delivered row + a fresher in-flight row: status is the fresher
    // row's (in_flight), NOT a history-merged 'delivered'. The read is of the
    // current row, full stop.
    const s = deriveThreadStatus("t1", [
      row({ delivery_id: "old", state: "executed", delivered: true, updated_at: 10 }),
      row({ delivery_id: "new", state: "accepted", delivered: false, updated_at: 20 }),
    ]);
    expect(s.kind).toBe("in_flight");
    expect(s.delivery_id).toBe("new");
  });

  it("surfaces the current row's delivered TerminalProof", () => {
    const s = deriveThreadStatus("t1", [
      row({ delivery_id: "d", state: "executed", delivered: true, updated_at: 42 }),
    ]);
    expect(s.kind).toBe("delivered");
    expect(s.delivery_id).toBe("d");
  });
});

describe("readThreadStatus — read-only source seam + I/O degrade", () => {
  it("reads via listByThread", () => {
    const source: ThreadRowSource = {
      listByThread: () => [row({ state: "executed", delivered: true })],
    };
    expect(readThreadStatus(source, "t1").kind).toBe("delivered");
  });

  it("a throwing source (uncreated outbox / mid-build) degrades to building", () => {
    const source: ThreadRowSource = {
      listByThread: () => {
        throw new Error("ENOENT: outbox dir not created");
      },
    };
    const s = readThreadStatus(source, "t1");
    expect(s.kind).toBe("building");
    expect(s.reason).toBe("substrate_absent");
  });

  it("an empty thread degrades to building/no_rows", () => {
    const source: ThreadRowSource = { listByThread: () => [] };
    expect(readThreadStatus(source, "t1").reason).toBe("no_rows");
  });
});
