/**
 * Unit tests for the "Needs you" watcher THIN I/O LAYER pure helpers +
 * the themed→role resolver.
 *
 * These cover the pure (I/O-free) decisions of the watcher: ledger parsing,
 * herald-push dedupe, delivery-proof escalation, heartbeat freshness, and the
 * de-jargoning role resolver. The shell/fs wrappers stay thin (not unit-tested
 * here — exercised by the E2E in Stage 6).
 */
import { describe, expect, it } from "vitest";
import {
  DELIVERY_CONFIRM_WINDOW_MS,
  decideDeliveryEscalation,
  heartbeatFresh,
  newlyDetectedIds,
  normalizeLedgerEvent,
  parseOpenDecisions,
  pushText,
  type PushLedger,
} from "../needs-you-watcher.js";
import { cellToRole, createRoleResolver, dejargonRoleHint } from "../needs-you-role-resolver.js";
import { STALE_WINDOW_MS, type NeedsYouItem } from "@blackbelt-technology/pi-dashboard-shared/needs-you-band.js";

function item(id: string, over: Partial<NeedsYouItem> = {}): NeedsYouItem {
  return {
    id,
    kind: "parked-decision",
    source: { origin: "ledger", event_id: id },
    label: `label ${id}`,
    action: "Decide it.",
    halt_tier: false,
    uncertain: false,
    lane: "operator-band",
    pushed_at: "2026-07-18T12:00:00Z",
    drilldown: {},
    ...over,
  };
}

// ── ledger parsing ──────────────────────────────────────────────────────────

describe("normalizeLedgerEvent — decodes the JSON-string payload", () => {
  it("decodes a payload emitted as a JSON string", () => {
    const e = normalizeLedgerEvent({ event_id: "dl-1", type: "production-gate", thread_id: "t", summary: "s", payload: '{"decision":"x","cell_id":"c"}' });
    expect(e.payload).toEqual({ decision: "x", cell_id: "c" });
  });

  it("passes through a payload already an object", () => {
    const e = normalizeLedgerEvent({ event_id: "dl-2", type: "t", thread_id: "t", summary: "s", payload: { a: 1 } });
    expect(e.payload).toEqual({ a: 1 });
  });

  it("a non-JSON payload string ⇒ { _raw }", () => {
    const e = normalizeLedgerEvent({ event_id: "dl-3", type: "t", thread_id: "t", summary: "s", payload: "not json" });
    expect(e.payload).toEqual({ _raw: "not json" });
  });

  it("carries top-level closes / status / source", () => {
    const e = normalizeLedgerEvent({ event_id: "dl-4", type: "production-apply", thread_id: "t", summary: "s", status: "closed", closes: "dl-1", source: "X" });
    expect(e.closes).toBe("dl-1");
    expect(e.status).toBe("closed");
    expect(e.source).toBe("X");
  });
});

describe("parseOpenDecisions", () => {
  it("parses a JSON array of rows", () => {
    const rows = parseOpenDecisions('[{"event_id":"dl-1","type":"operator-decision","thread_id":"t","summary":"s"}]');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.event_id).toBe("dl-1");
  });

  it("empty / malformed stdout ⇒ [] (graceful-degrade, never throws)", () => {
    expect(parseOpenDecisions("")).toEqual([]);
    expect(parseOpenDecisions("not json")).toEqual([]);
    expect(parseOpenDecisions("{}")).toEqual([]); // object, not array
  });
});

// ── herald-push dedupe ──────────────────────────────────────────────────────

describe("newlyDetectedIds — herald-push dedupe", () => {
  it("returns only not-yet-pushed operator-band item ids", () => {
    const items = [item("a"), item("b"), item("c")];
    expect(newlyDetectedIds(items, new Set(["b"]))).toEqual(["a", "c"]);
  });

  it("never re-pushes an already-pushed id (dedupe by id)", () => {
    const items = [item("a")];
    expect(newlyDetectedIds(items, new Set(["a"]))).toEqual([]);
  });

  it("EXCLUDES crew-lane items (routed off the operator band ⇒ not a loud push)", () => {
    const items = [item("a", { lane: "crew-lane" }), item("b", { lane: "operator-band" })];
    expect(newlyDetectedIds(items, new Set())).toEqual(["b"]);
  });
});

describe("pushText", () => {
  it("prefixes a HALT-tier item with the stop marker + carries label + action", () => {
    const t = pushText(item("a", { halt_tier: true, label: "Revoke a token", action: "Revoke it now." }));
    expect(t).toContain("🛑");
    expect(t).toContain("Revoke a token");
    expect(t).toContain("Revoke it now.");
  });

  it("marks an uncertain item with the query marker", () => {
    expect(pushText(item("a", { uncertain: true }))).toContain("❓");
  });
});

// ── delivery-proof escalation ───────────────────────────────────────────────

describe("decideDeliveryEscalation — Rule 5 delivery-proof", () => {
  const now = 1_000_000_000;
  const stale = now - DELIVERY_CONFIRM_WINDOW_MS - 1;
  const fresh = now - 1000;

  it("a pushed item unconfirmed past the window ⇒ escalate", () => {
    const ledger: PushLedger = { a: stale };
    expect(decideDeliveryEscalation(new Set(["a"]), ledger, [], now)).toEqual(["a"]);
  });

  it("a receipt covering the item ⇒ NOT escalated", () => {
    const ledger: PushLedger = { a: stale };
    const receipts = [{ received_item_ids: ["a"], received_at: "2026-07-18T12:00:00Z" }];
    expect(decideDeliveryEscalation(new Set(["a"]), ledger, receipts, now)).toEqual([]);
  });

  it("a pushed item still within the window ⇒ NOT yet escalated", () => {
    expect(decideDeliveryEscalation(new Set(["a"]), { a: fresh }, [], now)).toEqual([]);
  });

  it("an item no longer on the band (resolved/gone) ⇒ NOT escalated (no longer owed)", () => {
    expect(decideDeliveryEscalation(new Set(), { a: stale }, [], now)).toEqual([]);
  });
});

// ── heartbeat freshness (BLIND) ─────────────────────────────────────────────

describe("heartbeatFresh — BLIND liveness", () => {
  const now = Date.parse("2026-07-18T12:00:00Z");
  it("fresh heartbeat ⇒ true", () => {
    const hb = { last_beat_at: new Date(now - 10_000).toISOString(), watcher_pid: 1, cadence_ms: 30_000 };
    expect(heartbeatFresh(hb, now, STALE_WINDOW_MS)).toBe(true);
  });
  it("stale heartbeat (> window) ⇒ false", () => {
    const hb = { last_beat_at: new Date(now - STALE_WINDOW_MS - 1000).toISOString(), watcher_pid: 1, cadence_ms: 30_000 };
    expect(heartbeatFresh(hb, now, STALE_WINDOW_MS)).toBe(false);
  });
  it("missing heartbeat ⇒ false", () => {
    expect(heartbeatFresh(null, now, STALE_WINDOW_MS)).toBe(false);
  });
});

// ── themed→role resolver ────────────────────────────────────────────────────

describe("dejargonRoleHint", () => {
  it("extracts a clean role phrase from a jargon-laden status", () => {
    expect(dejargonRoleHint("L0.5 Peggy — operator inbox manager · tenure-67")).toBe("operator inbox manager");
  });
  it("strips tier codes + tenure tails", () => {
    const hint = dejargonRoleHint("L0.5b Joan tenure-152 — system-evolution synthesizer");
    expect(hint).toBe("system-evolution synthesizer");
    expect(hint).not.toMatch(/tenure|L0\.5|§|dl-/);
  });
  it("returns null for an unusable (too long / empty) hint", () => {
    expect(dejargonRoleHint("—")).toBeNull();
  });
});

describe("cellToRole", () => {
  it("strips a domain+ prefix and /vN suffix", () => {
    expect(cellToRole("harry+grocery-meal-planner-ios")).toBe("the grocery-meal-planner-ios driver");
    expect(cellToRole("cds-postprod/v1")).toBe("the cds-postprod driver");
  });
});

describe("createRoleResolver", () => {
  const registry = {
    roles: {
      peggy: { themed_name: "Peggy", status: "L0.5 Peggy — operator inbox manager · tenure-67" },
      salvatore: { themed_name: "Salvatore", status: "L1 Salvatore — postprod pipeline driver · tenure-3" },
    },
  };

  it("resolves a themed-name to its de-jargoned role phrase", () => {
    const resolve = createRoleResolver(registry);
    expect(resolve("Peggy")).toBe("the operator inbox manager");
    expect(resolve("Salvatore")).toBe("the postprod pipeline driver");
  });

  it("resolves a cell id to 'the <cell> driver'", () => {
    const resolve = createRoleResolver(registry);
    expect(resolve("harry+grocery-meal-planner")).toBe("the grocery-meal-planner driver");
  });

  it("NEVER emits a raw themed-name (falls back to a safe generic on an unknown)", () => {
    const resolve = createRoleResolver(registry);
    expect(resolve("UnknownName")).toBe("the driver");
  });

  it("empty key ⇒ 'the driver'", () => {
    expect(createRoleResolver(registry)("")).toBe("the driver");
  });
});
