/**
 * "Needs you" band REST API route (spec §5). Mirrors `surfaces-routes.ts`
 * (graceful-degrade, 5s cache, env-override path via the shared watcher paths).
 *
 *   GET  /api/needs-you-band
 *     Reads the watcher's feed file + liveness heartbeat file and returns the
 *     `NeedsYouBandResponse`. `watcher_live` is BLIND — computed ONLY from the
 *     heartbeat freshness (`STALE_WINDOW_MS`), NEVER inferred from item
 *     contents. File-missing ⇒ 200 with `items:[]`, `watcher_live:false`,
 *     `stale_reason:"watcher feed missing"` (graceful-degrade, NOT 5xx). A
 *     stale heartbeat ⇒ still return the (possibly stale) items BUT set
 *     `stale_reason` so the client goes loud-uncertain (never silently present
 *     a stale set as current).
 *
 *   POST /api/needs-you-band/delivery-receipt   (Rule 5 delivery-proof)
 *     Body `{ received_item_ids: string[], received_at: string }`. The client
 *     posts this after it RENDERS the band; the receipt is appended to the
 *     receipt file (env `NEEDS_YOU_RECEIPT_FILE`) which the watcher reads to
 *     PROVE the operator surface RECEIVED the fire (else it LOUD-fail-escalates).
 *
 * Paths + `heartbeatFresh` are imported from `needs-you-watcher.ts` (single
 * source of truth) so the route + watcher can never disagree on a location or
 * the staleness window.
 */

import type { FastifyInstance } from "fastify";
import type { NetworkGuard } from "./route-deps.js";
import fs from "node:fs/promises";
import { readJsonFile, writeJsonFile } from "../json-store.js";
import {
  FEED_CACHE_TTL_MS,
  STALE_WINDOW_MS,
  type NeedsYouBandResponse,
  type NeedsYouFeed,
  type NeedsYouWatcherHeartbeat,
} from "@blackbelt-technology/pi-dashboard-shared/needs-you-band.js";
import {
  feedPath,
  heartbeatFresh,
  heartbeatPath,
  receiptPath,
  type DeliveryReceipt,
} from "../needs-you-watcher.js";

// ── Pure response assembly (unit-tested) ────────────────────────────────────

/**
 * Assemble the `NeedsYouBandResponse` from the (possibly-null) feed + heartbeat.
 * BLIND liveness: `watcher_live` depends ONLY on the heartbeat freshness within
 * `STALE_WINDOW_MS` — never on the item contents.
 *
 *   feed=null                 ⇒ items:[], live:false, "watcher feed missing".
 *   heartbeat=null            ⇒ live:false, "watcher heartbeat missing".
 *   heartbeat stale (>window) ⇒ live:false, "heartbeat stale: last beat Ns ago"
 *                               BUT still return the feed's items (loud-uncertain
 *                               at the client, never a silent-stale drop).
 *   fresh                     ⇒ live:true, stale_reason:null.
 */
export function assembleBandResponse(
  feed: NeedsYouFeed | null,
  heartbeat: NeedsYouWatcherHeartbeat | null,
  now: number,
  windowMs: number = STALE_WINDOW_MS,
): NeedsYouBandResponse {
  const items = feed?.items ?? [];
  const computed_at = feed?.computed_at ?? null;
  const ledger_head = feed?.ledger_head ?? null;

  if (!feed) {
    return { items: [], watcher_live: false, computed_at: null, ledger_head: null, stale_reason: "watcher feed missing" };
  }
  if (!heartbeat) {
    return { items, watcher_live: false, computed_at, ledger_head, stale_reason: "watcher heartbeat missing" };
  }
  const live = heartbeatFresh(heartbeat, now, windowMs);
  if (!live) {
    const beatMs = Date.parse(heartbeat.last_beat_at);
    const agoS = Number.isNaN(beatMs) ? "unknown" : Math.round((now - beatMs) / 1000);
    return { items, watcher_live: false, computed_at, ledger_head, stale_reason: `heartbeat stale: last beat ${agoS}s ago` };
  }
  return { items, watcher_live: true, computed_at, ledger_head, stale_reason: null };
}

// ── 5s cache (mirrors surfaces-routes) ──────────────────────────────────────

interface CacheEntry {
  readAt: number;
  payload: NeedsYouBandResponse;
}
let cache: CacheEntry | null = null;

/** Reset the cache (testing). */
export function _resetNeedsYouBandCache(): void {
  cache = null;
}

/** Read the feed file (null on missing/invalid — graceful-degrade). */
async function readFeed(): Promise<NeedsYouFeed | null> {
  try {
    const raw = await fs.readFile(feedPath(), "utf-8");
    if (!raw.trim()) return null;
    return JSON.parse(raw) as NeedsYouFeed;
  } catch {
    return null;
  }
}

/** Read the heartbeat file (null on missing/invalid). */
async function readHeartbeat(): Promise<NeedsYouWatcherHeartbeat | null> {
  try {
    const raw = await fs.readFile(heartbeatPath(), "utf-8");
    if (!raw.trim()) return null;
    return JSON.parse(raw) as NeedsYouWatcherHeartbeat;
  } catch {
    return null;
  }
}

async function readBand(now: number): Promise<NeedsYouBandResponse> {
  if (cache && now - cache.readAt < FEED_CACHE_TTL_MS) return cache.payload;
  const [feed, heartbeat] = await Promise.all([readFeed(), readHeartbeat()]);
  const payload = assembleBandResponse(feed, heartbeat, now);
  cache = { readAt: now, payload };
  return payload;
}

// ── receipt append (delivery-proof) ─────────────────────────────────────────

/** Cap on retained receipts — the watcher only needs recent ones (5min window). */
export const MAX_RECEIPTS = 200;

/**
 * Append a delivery receipt to the receipt file (read-modify-write via the
 * atomic json-store). Bounded to the newest `MAX_RECEIPTS`. Exported pure-ish
 * (fs-touching) helper so the route stays thin.
 */
export function appendReceipt(receipt: DeliveryReceipt): void {
  const existing = readJsonFile<DeliveryReceipt[]>(receiptPath(), []);
  const next = [...existing, receipt].slice(-MAX_RECEIPTS);
  writeJsonFile(receiptPath(), next);
}

// ── route registration ──────────────────────────────────────────────────────

export function registerNeedsYouBandRoutes(
  fastify: FastifyInstance,
  deps: { networkGuard: NetworkGuard },
): void {
  const { networkGuard } = deps;

  fastify.get("/api/needs-you-band", { preHandler: networkGuard }, async (_request, reply) => {
    try {
      const payload = await readBand(Date.now());
      return { success: true, data: payload };
    } catch (err: any) {
      reply.code(500);
      return { success: false, error: `failed to read needs-you-band: ${err?.message ?? String(err)}` };
    }
  });

  fastify.post<{ Body: { received_item_ids?: string[]; received_at?: string } }>(
    "/api/needs-you-band/delivery-receipt",
    { preHandler: networkGuard },
    async (request, reply) => {
      const { received_item_ids, received_at } = request.body ?? {};
      if (!Array.isArray(received_item_ids) || typeof received_at !== "string") {
        reply.code(400);
        return { success: false, error: "received_item_ids (string[]) and received_at (string) required" };
      }
      try {
        appendReceipt({ received_item_ids, received_at });
        return { success: true };
      } catch (err: any) {
        reply.code(500);
        return { success: false, error: `failed to record receipt: ${err?.message ?? String(err)}` };
      }
    },
  );
}
