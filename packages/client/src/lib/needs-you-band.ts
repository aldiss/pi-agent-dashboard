/**
 * Pure client-side helpers for the "Needs you" band (Stage 5). No React, no
 * I/O — unit-testable. Splits the feed into the THREE render zones + orders the
 * main tier + carries Peggy's verbatim collapse-summary string.
 *
 * THE THREE ZONES (Peggy-ratified loudness-tiering, verdict §5a):
 *   1. MAIN LOUD must-act  — operator-band items that are NOT uncertain.
 *   2. LOWER-TIER collapse — operator-band items that ARE uncertain (the
 *      live-87 shape). Rendered as ONE quiet summary row, expandable.
 *   3. (crew-lane items are routed OFF the band — never rendered here.)
 *
 * `watcher_live=false` (a stale banner) + honest-empty are component concerns
 * (they read `watcherLive` + whether zone 1 is empty), not a partition.
 */

import type { NeedsYouItem } from "@blackbelt-technology/pi-dashboard-shared/needs-you-band.js";
export { isLegibleLabel } from "@blackbelt-technology/pi-dashboard-shared/needs-you-label.js";

/** The band split into its render zones. */
export interface BandZones {
  /** Zone 1 — the LOUD main must-act tier (operator-band, non-uncertain), ordered. */
  main: NeedsYouItem[];
  /** Zone 2 — the lower-tier uncertain items (operator-band, uncertain), for the collapse. */
  lowerTier: NeedsYouItem[];
}

/**
 * Main-tier kind priority (lower sorts first). HALT-tier `production-held`
 * leads (an irreversible production action held on the operator), then the
 * reversible/blocked kinds. Within a kind, `halt_tier` true sorts before false.
 */
const KIND_PRIORITY: Record<NeedsYouItem["kind"], number> = {
  "production-held": 0,
  "parked-decision": 1,
  "stalled-deliverable": 2,
  "phantom-hold": 3,
  "commitment-drop": 4,
  "runaway-cost": 5,
};

/**
 * Partition the feed items into the three zones. Crew-lane items are dropped
 * (routed off the band). `lane` absent ⇒ treated as `operator-band` (back-
 * compat). Main tier is ordered (halt_tier first, then kind priority, stable).
 */
export function partitionBandZones(items: readonly NeedsYouItem[]): BandZones {
  const main: NeedsYouItem[] = [];
  const lowerTier: NeedsYouItem[] = [];
  for (const it of items) {
    if (it.lane === "crew-lane") continue; // routed off the operator band
    if (it.uncertain) lowerTier.push(it);
    else main.push(it);
  }
  const ordered = main
    .map((item, idx) => ({ item, idx }))
    .sort((a, b) => {
      // halt_tier first (an explicit-nod production action outranks a reversible pick).
      if (a.item.halt_tier !== b.item.halt_tier) return a.item.halt_tier ? -1 : 1;
      const pk = KIND_PRIORITY[a.item.kind] - KIND_PRIORITY[b.item.kind];
      if (pk !== 0) return pk;
      return a.idx - b.idx; // stable
    })
    .map(({ item }) => item);
  return { main: ordered, lowerTier };
}

/**
 * Peggy's VERBATIM lower-tier collapse summary (verdict §5a.2). NO reconcile /
 * stale / pending jargon — operator-language only.
 */
export function lowerTierSummary(count: number): string {
  return `${count} older decisions we couldn't confirm are resolved — expand to review.`;
}

/**
 * The item ids the client posts in the delivery-receipt after RENDER (Rule 5).
 * Both zones count as "reached the operator surface" — main AND the lower-tier
 * collapse are on the operator band (crew-lane is not, and is already excluded
 * from the zones). Proves the fire was RECEIVED, not just emitted.
 */
export function renderedReceiptIds(zones: BandZones): string[] {
  return [...zones.main, ...zones.lowerTier].map((i) => i.id);
}

/** True iff the band has nothing on the operator band (both zones empty). */
export function isBandEmpty(zones: BandZones): boolean {
  return zones.main.length === 0 && zones.lowerTier.length === 0;
}
