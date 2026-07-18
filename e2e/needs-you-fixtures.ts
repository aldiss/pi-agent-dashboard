/**
 * Stage-6 E2E fixtures + synthetic-feed writer for the "Needs you" band.
 *
 * The band's server route reads the watcher's feed + heartbeat files (paths are
 * env-overridable — `NEEDS_YOU_MUST_ACT_FILE` / `NEEDS_YOU_WATCHER_LIVENESS_FILE`
 * / `NEEDS_YOU_RECEIPT_FILE`). The E2E boots a server pointed at a temp fixtures
 * dir and DRIVES the band by writing synthetic feeds here — no live watcher, no
 * live ledger. This tests the real route → real component path deterministically.
 */
import fs from "node:fs";
import path from "node:path";

export const FIXTURES_DIR = path.join(process.cwd(), "e2e", ".needs-you-fixtures");
export const FEED_FILE = path.join(FIXTURES_DIR, "feed.json");
export const HEARTBEAT_FILE = path.join(FIXTURES_DIR, "heartbeat.json");
export const RECEIPT_FILE = path.join(FIXTURES_DIR, "receipts.json");

/** The env the server-under-test must boot with so the route reads our fixtures. */
export function fixtureEnv(): Record<string, string> {
  return {
    NEEDS_YOU_MUST_ACT_FILE: FEED_FILE,
    NEEDS_YOU_WATCHER_LIVENESS_FILE: HEARTBEAT_FILE,
    NEEDS_YOU_RECEIPT_FILE: RECEIPT_FILE,
  };
}

// ── Synthetic item builders (mirror the SURFACE-CONTRACT-v0 shape) ──────────

export interface SynthItem {
  id: string;
  kind: string;
  source: { origin: string; event_id?: string; ledger_type?: string; derived_state?: string; thread_id?: string; cell_id?: string };
  label: string;
  action: string;
  halt_tier: boolean;
  uncertain: boolean;
  lane: string;
  pushed_at: string;
  drilldown: { event_id?: string; thread_id?: string; raw_summary?: string };
}

const NOW_ISO = "2026-07-18T12:00:00Z";

export function productionHeld(over: Partial<SynthItem> = {}): SynthItem {
  return {
    id: "ny-held", kind: "production-held",
    source: { origin: "ledger", ledger_type: "production-gate", event_id: "dl-6858", thread_id: "peggy+cds-postprod" },
    label: "A live GitHub token with full access to all your repos — anyone with it can push to every repo you own",
    action: "Revoke the GitHub CLI OAuth app — Settings, Applications, Authorized OAuth Apps, GitHub CLI, Revoke, then re-auth gh.",
    halt_tier: true, uncertain: false, lane: "operator-band", pushed_at: NOW_ISO,
    drilldown: { event_id: "dl-6858", thread_id: "peggy+cds-postprod", raw_summary: "F1 LIVE PRIVACY INCIDENT verified own-hand" },
    ...over,
  };
}

export function stalledDeliverable(over: Partial<SynthItem> = {}): SynthItem {
  return {
    id: "ny-block", kind: "stalled-deliverable",
    source: { origin: "ledger", ledger_type: "terminal-blocked", event_id: "dl-7878", thread_id: "harry+grocery" },
    label: "The grocery-app build is blocked: stuck at Xcode signing with no valid certificate",
    action: "Add a valid iOS signing certificate in Xcode.",
    halt_tier: false, uncertain: false, lane: "operator-band", pushed_at: NOW_ISO,
    drilldown: { event_id: "dl-7878", thread_id: "harry+grocery" },
    ...over,
  };
}

export function parkedDecision(over: Partial<SynthItem> = {}): SynthItem {
  return {
    id: "ny-parked", kind: "parked-decision",
    source: { origin: "ledger", ledger_type: "operator-decision", event_id: "dl-9100", thread_id: "growth+checkout" },
    label: "Which checkout flow to ship: the two-step or the one-page",
    action: "Pick the checkout flow in the experiment dashboard, then resume the test.",
    halt_tier: false, uncertain: false, lane: "operator-band", pushed_at: NOW_ISO,
    drilldown: { event_id: "dl-9100" },
    ...over,
  };
}

export function uncertainRows(n: number): SynthItem[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `ny-u${i}`, kind: "parked-decision",
    source: { origin: "ledger", ledger_type: "operator-decision", event_id: `dl-${3000 + i}` },
    label: `An older decision we couldn't confirm is resolved (number ${i + 1})`,
    action: "Decide it or confirm it's resolved.",
    halt_tier: false, uncertain: true, lane: "operator-band", pushed_at: NOW_ISO,
    drilldown: { event_id: `dl-${3000 + i}` },
  }));
}

// ── Feed / heartbeat / receipt writers ──────────────────────────────────────

export function ensureFixturesDir(): void {
  fs.mkdirSync(FIXTURES_DIR, { recursive: true });
}

/** Write the feed file (the route's 5s cache means specs should allow a poll cycle). */
export function writeFeed(items: SynthItem[], opts: { ledgerHead?: string } = {}): void {
  ensureFixturesDir();
  const feed = {
    schema_version: "surface-contract-v0",
    computed_at: NOW_ISO,
    ledger_head: opts.ledgerHead ?? "dl-9347",
    items,
  };
  fs.writeFileSync(FEED_FILE, JSON.stringify(feed, null, 2));
}

/** Remove the feed file entirely (graceful-degrade / feed-missing scenario). */
export function removeFeed(): void {
  try { fs.rmSync(FEED_FILE, { force: true }); } catch { /* noop */ }
}

/** Write a FRESH heartbeat (watcher_live=true). */
export function writeFreshHeartbeat(): void {
  ensureFixturesDir();
  fs.writeFileSync(HEARTBEAT_FILE, JSON.stringify({ last_beat_at: nowIso(), watcher_pid: 4242, cadence_ms: 30_000 }, null, 2));
}

/** Write a STALE heartbeat (watcher_live=false — the heartbeat-kill scenario). */
export function writeStaleHeartbeat(agoSeconds = 214): void {
  ensureFixturesDir();
  const at = new Date(Date.now() - agoSeconds * 1000).toISOString();
  fs.writeFileSync(HEARTBEAT_FILE, JSON.stringify({ last_beat_at: at, watcher_pid: 4242, cadence_ms: 30_000 }, null, 2));
}

/** Remove the heartbeat file (heartbeat-missing scenario). */
export function removeHeartbeat(): void {
  try { fs.rmSync(HEARTBEAT_FILE, { force: true }); } catch { /* noop */ }
}

/** Read the delivery receipts the route recorded (delivery-proof assertion). */
export function readReceipts(): Array<{ received_item_ids: string[]; received_at: string }> {
  try {
    const raw = fs.readFileSync(RECEIPT_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/** Clear the receipt file between scenarios. */
export function clearReceipts(): void {
  try { fs.rmSync(RECEIPT_FILE, { force: true }); } catch { /* noop */ }
}

/** Fresh ISO now — for the heartbeat. (Real clock is fine in the harness.) */
function nowIso(): string {
  return new Date().toISOString();
}
