/**
 * Unit tests for the pure client-side "Needs you" band helpers (Stage 5):
 * zone partition + main-tier ordering + Peggy's verbatim collapse summary +
 * delivery-receipt id assembly.
 */
import { describe, expect, it } from "vitest";
import {
  isBandEmpty,
  lowerTierSummary,
  partitionBandZones,
  renderedReceiptIds,
} from "../needs-you-band.js";
import type { NeedsYouItem } from "@blackbelt-technology/pi-dashboard-shared/needs-you-band.js";

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

describe("partitionBandZones", () => {
  it("splits operator-band non-uncertain → main, uncertain → lowerTier", () => {
    const z = partitionBandZones([
      item("a", { uncertain: false }),
      item("b", { uncertain: true }),
      item("c", { uncertain: false }),
    ]);
    expect(z.main.map((i) => i.id).sort()).toEqual(["a", "c"]);
    expect(z.lowerTier.map((i) => i.id)).toEqual(["b"]);
  });

  it("DROPS crew-lane items (routed off the operator band — never rendered)", () => {
    const z = partitionBandZones([
      item("a", { lane: "operator-band" }),
      item("b", { lane: "crew-lane" }),
      item("c", { lane: "crew-lane", uncertain: true }),
    ]);
    expect(z.main.map((i) => i.id)).toEqual(["a"]);
    expect(z.lowerTier).toEqual([]);
  });

  it("treats an absent lane as operator-band (back-compat)", () => {
    const noLane = item("a");
    delete (noLane as { lane?: unknown }).lane;
    expect(partitionBandZones([noLane]).main.map((i) => i.id)).toEqual(["a"]);
  });

  it("orders the main tier: halt_tier first, then kind priority, stable", () => {
    const z = partitionBandZones([
      item("runaway", { kind: "runaway-cost" }),
      item("parked", { kind: "parked-decision" }),
      item("held", { kind: "production-held", halt_tier: true }),
      item("stalled", { kind: "stalled-deliverable" }),
    ]);
    // held (halt_tier) leads; then parked < stalled < runaway by kind priority.
    expect(z.main.map((i) => i.id)).toEqual(["held", "parked", "stalled", "runaway"]);
  });

  it("halt_tier outranks kind priority (a halt runaway leads a non-halt production-held)", () => {
    const z = partitionBandZones([
      item("held", { kind: "production-held", halt_tier: false }),
      item("haltRunaway", { kind: "runaway-cost", halt_tier: true }),
    ]);
    expect(z.main[0]!.id).toBe("haltRunaway");
  });

  it("is stable for equal keys (input order preserved)", () => {
    const z = partitionBandZones([
      item("p1", { kind: "parked-decision" }),
      item("p2", { kind: "parked-decision" }),
      item("p3", { kind: "parked-decision" }),
    ]);
    expect(z.main.map((i) => i.id)).toEqual(["p1", "p2", "p3"]);
  });
});

describe("lowerTierSummary — Peggy verbatim", () => {
  it("renders the exact operator-language string (no reconcile/stale/pending jargon)", () => {
    expect(lowerTierSummary(87)).toBe("87 older decisions we couldn't confirm are resolved — expand to review.");
    expect(lowerTierSummary(1)).toContain("1 older decisions we couldn't confirm are resolved");
    // Anti-jargon guard.
    const s = lowerTierSummary(5);
    expect(s).not.toMatch(/reconcile|stale|pending|uncertain|supersede/i);
  });
});

describe("renderedReceiptIds", () => {
  it("includes BOTH main + lower-tier ids (both are on the operator band)", () => {
    const z = partitionBandZones([
      item("m1", { uncertain: false }),
      item("u1", { uncertain: true }),
    ]);
    expect(renderedReceiptIds(z).sort()).toEqual(["m1", "u1"]);
  });

  it("excludes crew-lane ids (already dropped from the zones)", () => {
    const z = partitionBandZones([item("m1"), item("c1", { lane: "crew-lane" })]);
    expect(renderedReceiptIds(z)).toEqual(["m1"]);
  });
});

describe("isBandEmpty", () => {
  it("true only when both zones are empty", () => {
    expect(isBandEmpty(partitionBandZones([]))).toBe(true);
    expect(isBandEmpty(partitionBandZones([item("a")]))).toBe(false);
    expect(isBandEmpty(partitionBandZones([item("a", { uncertain: true })]))).toBe(false);
    // Only crew-lane items ⇒ both zones empty ⇒ band empty.
    expect(isBandEmpty(partitionBandZones([item("a", { lane: "crew-lane" })]))).toBe(true);
  });
});
