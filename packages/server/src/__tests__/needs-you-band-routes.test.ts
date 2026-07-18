/**
 * Unit tests for the "Needs you" band server route (spec §5):
 *   - `assembleBandResponse` — the PURE BLIND-liveness + graceful-degrade
 *     response assembly (both ways: fresh→live, stale/missing→loud-uncertain).
 *   - `appendReceipt` — the delivery-proof receipt append (real fs round-trip
 *     under an env-overridden path; bounded to MAX_RECEIPTS).
 *
 * The Fastify wiring itself is thin (exercised by the E2E in Stage 6).
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MAX_RECEIPTS,
  appendReceipt,
  assembleBandResponse,
} from "../routes/needs-you-band-routes.js";
import { readReceipts } from "../needs-you-watcher.js";
import { STALE_WINDOW_MS, type NeedsYouFeed, type NeedsYouItem, type NeedsYouWatcherHeartbeat } from "@blackbelt-technology/pi-dashboard-shared/needs-you-band.js";

const NOW = Date.parse("2026-07-18T12:00:00Z");

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

function feed(items: NeedsYouItem[]): NeedsYouFeed {
  return { schema_version: "surface-contract-v0", computed_at: "2026-07-18T11:59:50Z", ledger_head: "dl-9347", items };
}

function heartbeat(agoMs: number): NeedsYouWatcherHeartbeat {
  return { last_beat_at: new Date(NOW - agoMs).toISOString(), watcher_pid: 123, cadence_ms: 30_000 };
}

// ── assembleBandResponse — BLIND liveness + graceful-degrade ────────────────

describe("assembleBandResponse — BLIND liveness", () => {
  it("fresh heartbeat ⇒ watcher_live=true, no stale_reason", () => {
    const r = assembleBandResponse(feed([item("a")]), heartbeat(10_000), NOW);
    expect(r.watcher_live).toBe(true);
    expect(r.stale_reason).toBeNull();
    expect(r.items).toHaveLength(1);
    expect(r.ledger_head).toBe("dl-9347");
  });

  it("stale heartbeat (>window) ⇒ watcher_live=false + stale_reason, BUT still returns items (loud-uncertain, not silent-stale)", () => {
    const r = assembleBandResponse(feed([item("a"), item("b")]), heartbeat(STALE_WINDOW_MS + 124_000), NOW);
    expect(r.watcher_live).toBe(false);
    expect(r.stale_reason).toMatch(/heartbeat stale: last beat \d+s ago/);
    expect(r.items).toHaveLength(2); // NEVER silently drops the stale set
  });

  it("BLIND: watcher_live is computed ONLY from the heartbeat, NOT the items", () => {
    // Same non-empty items, only the heartbeat differs ⇒ liveness flips.
    const items = [item("a")];
    expect(assembleBandResponse(feed(items), heartbeat(1_000), NOW).watcher_live).toBe(true);
    expect(assembleBandResponse(feed(items), heartbeat(STALE_WINDOW_MS + 1_000), NOW).watcher_live).toBe(false);
    // Empty items + fresh heartbeat ⇒ STILL live (liveness never reads contents).
    expect(assembleBandResponse(feed([]), heartbeat(1_000), NOW).watcher_live).toBe(true);
  });

  it("feed missing ⇒ 200-shape: items:[], live:false, 'watcher feed missing'", () => {
    const r = assembleBandResponse(null, heartbeat(1_000), NOW);
    expect(r).toEqual({ items: [], watcher_live: false, computed_at: null, ledger_head: null, stale_reason: "watcher feed missing" });
  });

  it("heartbeat missing (feed present) ⇒ live:false, 'watcher heartbeat missing', items retained", () => {
    const r = assembleBandResponse(feed([item("a")]), null, NOW);
    expect(r.watcher_live).toBe(false);
    expect(r.stale_reason).toBe("watcher heartbeat missing");
    expect(r.items).toHaveLength(1);
  });

  it("exactly-at-window heartbeat is still fresh (<=, boundary)", () => {
    const r = assembleBandResponse(feed([item("a")]), heartbeat(STALE_WINDOW_MS), NOW);
    expect(r.watcher_live).toBe(true);
  });

  it("carries the uncertain flag through unchanged (main-tier vs lower-tier split is client-side)", () => {
    const r = assembleBandResponse(feed([item("a", { uncertain: false }), item("b", { uncertain: true })]), heartbeat(1_000), NOW);
    expect(r.items.find((i) => i.id === "a")!.uncertain).toBe(false);
    expect(r.items.find((i) => i.id === "b")!.uncertain).toBe(true);
  });
});

// ── appendReceipt — delivery-proof round-trip ───────────────────────────────

describe("appendReceipt — delivery-proof receipt file", () => {
  let dir: string;
  const prev = process.env.NEEDS_YOU_RECEIPT_FILE;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (prev === undefined) delete process.env.NEEDS_YOU_RECEIPT_FILE;
    else process.env.NEEDS_YOU_RECEIPT_FILE = prev;
  });

  it("appends a receipt the watcher can read back", () => {
    dir = mkdtempSync(path.join(tmpdir(), "needs-you-receipt-"));
    process.env.NEEDS_YOU_RECEIPT_FILE = path.join(dir, "receipts.json");
    appendReceipt({ received_item_ids: ["a", "b"], received_at: "2026-07-18T12:00:00Z" });
    const back = readReceipts();
    expect(back).toHaveLength(1);
    expect(back[0]!.received_item_ids).toEqual(["a", "b"]);
  });

  it("accumulates receipts across posts", () => {
    dir = mkdtempSync(path.join(tmpdir(), "needs-you-receipt-"));
    process.env.NEEDS_YOU_RECEIPT_FILE = path.join(dir, "receipts.json");
    appendReceipt({ received_item_ids: ["a"], received_at: "t1" });
    appendReceipt({ received_item_ids: ["b"], received_at: "t2" });
    expect(readReceipts()).toHaveLength(2);
  });

  it("bounds retention to the newest MAX_RECEIPTS", () => {
    dir = mkdtempSync(path.join(tmpdir(), "needs-you-receipt-"));
    process.env.NEEDS_YOU_RECEIPT_FILE = path.join(dir, "receipts.json");
    for (let i = 0; i < MAX_RECEIPTS + 25; i++) appendReceipt({ received_item_ids: [`i${i}`], received_at: `t${i}` });
    const back = readReceipts();
    expect(back).toHaveLength(MAX_RECEIPTS);
    // The OLDEST were dropped; the newest is retained.
    expect(back.at(-1)!.received_item_ids).toEqual([`i${MAX_RECEIPTS + 24}`]);
    expect(back[0]!.received_item_ids).toEqual([`i25`]);
  });
});
