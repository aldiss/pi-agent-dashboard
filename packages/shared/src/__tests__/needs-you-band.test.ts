/**
 * Unit tests for the "Needs you" band SURFACE-CONTRACT-v0 shared types +
 * config constants + the pure `stableItemId` dedupe helper.
 *
 * Cell: pi-agent-dashboard-needs-you-band. Stage 1.
 */
import { describe, expect, it } from "vitest";
import {
  CLIENT_POLL_INTERVAL_MS,
  FEED_CACHE_TTL_MS,
  MAX_LABEL_CHARS,
  NEEDS_YOU_FEED_BASENAME,
  NEEDS_YOU_FEED_ENV,
  NEEDS_YOU_HEARTBEAT_BASENAME,
  NEEDS_YOU_HEARTBEAT_ENV,
  NEEDS_YOU_KINDS,
  STALE_WINDOW_MS,
  WATCHER_CADENCE_MS,
  stableItemId,
  type NeedsYouKind,
  type NeedsYouSource,
} from "../needs-you-band.js";

describe("config constants", () => {
  it("MAX_LABEL_CHARS soft-default is 120 (Peggy calibrates)", () => {
    expect(MAX_LABEL_CHARS).toBe(120);
  });

  it("STALE_WINDOW_MS is 90s = three missed 30s beats", () => {
    expect(STALE_WINDOW_MS).toBe(90_000);
    expect(STALE_WINDOW_MS).toBe(3 * WATCHER_CADENCE_MS);
  });

  it("WATCHER_CADENCE_MS is 30s", () => {
    expect(WATCHER_CADENCE_MS).toBe(30_000);
  });

  it("server cache TTL mirrors surfaces-routes 5s", () => {
    expect(FEED_CACHE_TTL_MS).toBe(5_000);
  });

  it("client poll cadence mirrors useFleetBrief 15s", () => {
    expect(CLIENT_POLL_INTERVAL_MS).toBe(15_000);
  });

  it("env-var names + basenames match the canonical contract", () => {
    expect(NEEDS_YOU_FEED_ENV).toBe("NEEDS_YOU_MUST_ACT_FILE");
    expect(NEEDS_YOU_FEED_BASENAME).toBe("needs-you-must-act-set.json");
    expect(NEEDS_YOU_HEARTBEAT_ENV).toBe("NEEDS_YOU_WATCHER_LIVENESS_FILE");
    expect(NEEDS_YOU_HEARTBEAT_BASENAME).toBe(".needs-you-watcher-liveness.json");
  });
});

describe("NEEDS_YOU_KINDS", () => {
  it("holds exactly the six DISTINCT kinds (no C3/C6, no collapse)", () => {
    expect([...NEEDS_YOU_KINDS]).toEqual([
      "parked-decision",
      "production-held",
      "stalled-deliverable",
      "phantom-hold",
      "commitment-drop",
      "runaway-cost",
    ]);
  });

  it("production-held is a distinct HALT-tier kind (split from parked-decision)", () => {
    expect(NEEDS_YOU_KINDS).toContain("production-held");
    expect(NEEDS_YOU_KINDS).toContain("parked-decision");
  });

  it("runaway-cost is present + distinct (never folded into stalled)", () => {
    expect(NEEDS_YOU_KINDS).toContain("runaway-cost");
    expect(NEEDS_YOU_KINDS).toContain("stalled-deliverable");
    const unique = new Set<NeedsYouKind>(NEEDS_YOU_KINDS);
    expect(unique.size).toBe(NEEDS_YOU_KINDS.length);
  });

  it("is frozen (immutable taxonomy)", () => {
    expect(Object.isFrozen(NEEDS_YOU_KINDS)).toBe(true);
  });
});

describe("stableItemId", () => {
  const ledgerSource: NeedsYouSource = {
    origin: "ledger",
    ledger_type: "production-gate",
    event_id: "dl-6858",
    thread_id: "cds-postprod",
    cell_id: "cds-postprod",
  };

  it("is deterministic — same source ⇒ same id (re-compute dedupe)", () => {
    expect(stableItemId(ledgerSource)).toBe(stableItemId({ ...ledgerSource }));
  });

  it("has the ny- prefix + 8-hex-char body", () => {
    expect(stableItemId(ledgerSource)).toMatch(/^ny-[0-9a-f]{8}$/);
  });

  it("distinct sources ⇒ distinct ids", () => {
    const other: NeedsYouSource = {
      origin: "ledger",
      ledger_type: "terminal-blocked",
      event_id: "dl-7878",
      thread_id: "grocery-meal-planner-ios",
    };
    expect(stableItemId(ledgerSource)).not.toBe(stableItemId(other));
  });

  it("a derived source keys off derived_state + cell (not event_id)", () => {
    const stalled: NeedsYouSource = {
      origin: "derived",
      derived_state: "stalled",
      cell_id: "podcast-pipeline",
    };
    const idle: NeedsYouSource = {
      origin: "derived",
      derived_state: "idle",
      cell_id: "podcast-pipeline",
    };
    // Same cell, different derived_state ⇒ different id.
    expect(stableItemId(stalled)).not.toBe(stableItemId(idle));
    // Same derived source recomputes stable.
    expect(stableItemId(stalled)).toBe(stableItemId({ ...stalled }));
  });

  it("ledger vs derived origin on the same cell ⇒ distinct ids", () => {
    const asLedger: NeedsYouSource = { origin: "ledger", ledger_type: "terminal-blocked", cell_id: "x" };
    const asDerived: NeedsYouSource = { origin: "derived", derived_state: "stalled", cell_id: "x" };
    expect(stableItemId(asLedger)).not.toBe(stableItemId(asDerived));
  });
});
