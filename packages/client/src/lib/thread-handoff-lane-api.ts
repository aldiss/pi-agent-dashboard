/**
 * Tier-1 read-only visibility — the HAND-OFF lane client contract + fetcher
 * (design v0.3 Tier-1 §"What Tier-1 IS" #3, the hand-off lane; M6).
 *
 * Reads the P1 server hand-off-lane read (the v2-ledger keyset range over
 * `thread-holder-change` events). The lane is EMPTY until the A4
 * `thread-holder-change` verb lands (grep = 0 in the ledger today) — so the
 * honest Tier-1 output is an empty lane, graceful-degraded and clearly labeled,
 * never a fabricated holder-change row.
 *
 * READ-ONLY: reuses the shared P1 `LedgerEvent` type (the pure keyset logic
 * lives in `thread-durability/tier1/ledger-range.ts`). This module only fetches
 * + renders; it drives nothing.
 */
import { getApiBase } from "./api-context.js";
import type { LedgerEvent } from "@blackbelt-technology/pi-dashboard-shared/thread-durability/tier1/ledger-range.js";

export type { LedgerEvent };

/** Result of a hand-off lane fetch — distinguishes "unregistered" from empty. */
export interface HandoffLaneResult {
  events: LedgerEvent[];
  /** False when the endpoint is unregistered/404 (held-activation). */
  endpointAvailable: boolean;
}

/**
 * Fetch a thread's hand-off lane (read-only) — the P1 v2-ledger keyset range of
 * `thread-holder-change` events, in monotonic `numeric_seq` order. Degrades
 * GRACEFULLY: an unregistered route (held-activation) OR a thread with no
 * hand-off events both resolve to an EMPTY lane. An empty lane is the CORRECT
 * Tier-1 output until the A4 verb lands — not an error, not a crash.
 */
export async function fetchHandoffLane(threadId: string): Promise<HandoffLaneResult> {
  const res = await fetch(`${getApiBase()}/api/threads/${encodeURIComponent(threadId)}/handoff-lane`);
  if (res.status === 404) return { events: [], endpointAvailable: false };
  if (!res.ok) throw new Error(`handoff-lane request failed (${res.status})`);
  const body = await res.json();
  if (!body?.success) return { events: [], endpointAvailable: false };
  const events: LedgerEvent[] = body.data?.events ?? [];
  return { events, endpointAvailable: true };
}
