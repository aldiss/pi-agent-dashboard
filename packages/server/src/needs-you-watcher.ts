/**
 * "Needs you" band — the watcher's THIN I/O LAYER + standing tick (spec §4b).
 *
 * The pure core (`computeMustActSet`, needs-you-watcher-core.ts) does ALL the
 * curation logic against INJECTED inputs. This module is the only place that
 * touches the outside world:
 *
 *   READS   — `decision-ledger open-decisions --json` (candidate source, the
 *             closes-edge-honoring projection) + `decision-ledger replay
 *             --thread-id <T> --json` (the supersede-scan thread index) +
 *             the cell-driver-registry + tmux pane state.
 *   WRITES  — the feed file (atomic tmp+rename) + the liveness heartbeat file,
 *             every 30s tick.
 *   PUSHES  — `herald-send` on a NEWLY-detected must-act (loud = pushed),
 *             deduped by item id so it does not re-push every tick.
 *   PROVES  — delivery-proof: tracks pushed items; if a pushed item goes
 *             unconfirmed past a window (no receipt), LOUD-fail-escalates.
 *
 * SPLIT: pure helpers (parse / dedupe / escalation-decision / heartbeat-fresh)
 * are exported + unit-tested; the shell/fs wrappers are thin; `runTick`
 * composes them; `runWatcherLoop` is the standing entry. Keep the loop thin —
 * all curation logic lives in the core, all decisions here are pure helpers.
 */

import os from "node:os";
import path from "node:path";
import { spawnSync } from "@blackbelt-technology/pi-dashboard-shared/platform/exec.js";
import { readJsonFile, writeJsonFile } from "./json-store.js";
import {
  NEEDS_YOU_FEED_BASENAME,
  NEEDS_YOU_FEED_ENV,
  NEEDS_YOU_HEARTBEAT_BASENAME,
  NEEDS_YOU_HEARTBEAT_ENV,
  ORCHESTRATION_STATE_DIR_SEGMENTS,
  WATCHER_CADENCE_MS,
  type NeedsYouFeed,
  type NeedsYouItem,
  type NeedsYouWatcherHeartbeat,
} from "@blackbelt-technology/pi-dashboard-shared/needs-you-band.js";
import {
  computeMustActSet,
  type DriverRow,
  type LedgerEvent,
  type MustActDeps,
  type PaneRow,
} from "./needs-you-watcher-core.js";

// ── Canonical paths (env-overridable — mirrors surfaces-routes.ts) ──────────

/** `~`-expansion + env override, sister to `surfaces-routes#resolveCanonicalPath`. */
function resolveStatePath(envVar: string, basename: string): string {
  const override = process.env[envVar];
  if (override && override.length > 0) {
    return override.startsWith("~") ? path.join(os.homedir(), override.slice(1)) : override;
  }
  return path.join(os.homedir(), ...ORCHESTRATION_STATE_DIR_SEGMENTS, basename);
}

export function feedPath(): string {
  return resolveStatePath(NEEDS_YOU_FEED_ENV, NEEDS_YOU_FEED_BASENAME);
}
export function heartbeatPath(): string {
  return resolveStatePath(NEEDS_YOU_HEARTBEAT_ENV, NEEDS_YOU_HEARTBEAT_BASENAME);
}
/** Delivery receipt file (written by the Stage-4 route; read here for proof). */
export const NEEDS_YOU_RECEIPT_ENV = "NEEDS_YOU_RECEIPT_FILE";
export const NEEDS_YOU_RECEIPT_BASENAME = ".needs-you-delivery-receipts.json";
export function receiptPath(): string {
  return resolveStatePath(NEEDS_YOU_RECEIPT_ENV, NEEDS_YOU_RECEIPT_BASENAME);
}

/** Registry + delivery windows. */
export const REGISTRY_BASENAME = "cell-driver-registry.json";
export function registryPath(): string {
  return path.join(os.homedir(), ...ORCHESTRATION_STATE_DIR_SEGMENTS, REGISTRY_BASENAME);
}
/** A pushed item unconfirmed past this ⇒ LOUD delivery-fail escalation. 5 min. */
export const DELIVERY_CONFIRM_WINDOW_MS = 5 * 60 * 1000;

/**
 * Max stdout buffer for `decision-ledger` shells. The live `open-decisions
 * --json` output is ~1.1 MB (2185 rows) — WELL over spawnSync's 1 MB default,
 * which fails ENOBUFS (killed, status=null). 64 MB gives generous headroom as
 * the ledger grows. (Found by the Stage-3 live smoke test — unit tests can't
 * catch a shell-buffer overflow.)
 */
export const LEDGER_MAX_BUFFER = 64 * 1024 * 1024;

// ── Pure helpers (unit-tested) ──────────────────────────────────────────────

/** Parse `decision-ledger open-decisions --json` stdout → LedgerEvent[]. */
export function parseOpenDecisions(stdout: string): LedgerEvent[] {
  const raw = safeJsonArray(stdout);
  return raw.map(normalizeLedgerEvent);
}

/** Parse a `decision-ledger replay --json` stdout → LedgerEvent[]. */
export function parseReplay(stdout: string): LedgerEvent[] {
  return safeJsonArray(stdout).map(normalizeLedgerEvent);
}

/**
 * Normalize a raw ledger row: the CLI emits `payload` as a JSON-encoded STRING
 * (and top-level fields alongside). Decode `payload` to an object so the core
 * reads structured fields. A non-JSON payload string ⇒ `{ _raw: string }`.
 */
export function normalizeLedgerEvent(row: Record<string, unknown>): LedgerEvent {
  let payload: Record<string, unknown> | undefined;
  const p = row["payload"];
  if (p && typeof p === "object") {
    payload = p as Record<string, unknown>;
  } else if (typeof p === "string") {
    try {
      payload = JSON.parse(p) as Record<string, unknown>;
    } catch {
      payload = { _raw: p };
    }
  }
  return {
    event_id: String(row["event_id"] ?? ""),
    ts: String(row["ts"] ?? ""),
    type: String(row["type"] ?? ""),
    thread_id: String(row["thread_id"] ?? ""),
    summary: String(row["summary"] ?? ""),
    status: (row["status"] as LedgerEvent["status"]) ?? undefined,
    closes: typeof row["closes"] === "string" ? (row["closes"] as string) : undefined,
    source: typeof row["source"] === "string" ? (row["source"] as string) : undefined,
    payload,
  };
}

/**
 * The set of item ids to herald-push THIS tick: items present now that were not
 * pushed before. Deduped so a still-open must-act does not re-push every tick.
 * Returns the new ids (to push) — caller unions them into `alreadyPushed`.
 */
export function newlyDetectedIds(items: NeedsYouItem[], alreadyPushed: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const it of items) {
    // Only push items that actually reach the operator band (crew-lane items
    // are routed off the band — not a loud operator push).
    if (it.lane === "crew-lane") continue;
    if (!alreadyPushed.has(it.id)) out.push(it.id);
  }
  return out;
}

/** A recorded delivery receipt (written by the Stage-4 route). */
export interface DeliveryReceipt {
  received_item_ids: string[];
  received_at: string;
}

/** Tracks when each operator-band item id was first pushed (for the proof window). */
export type PushLedger = Record<string, number>; // item id → first-pushed epoch ms

/**
 * Delivery-proof decision (Rule 5): a pushed item that is STILL current, was
 * pushed longer than the window ago, and has NO receipt covering it ⇒ its
 * delivery is UNCONFIRMED → escalate. Pure.
 */
export function decideDeliveryEscalation(
  currentBandIds: ReadonlySet<string>,
  pushLedger: PushLedger,
  receipts: readonly DeliveryReceipt[],
  now: number,
  windowMs: number = DELIVERY_CONFIRM_WINDOW_MS,
): string[] {
  const confirmed = new Set<string>();
  for (const r of receipts) for (const id of r.received_item_ids) confirmed.add(id);
  const unconfirmed: string[] = [];
  for (const [id, pushedAt] of Object.entries(pushLedger)) {
    if (!currentBandIds.has(id)) continue; // resolved/gone — no longer owed
    if (confirmed.has(id)) continue; // receipt covers it
    if (now - pushedAt > windowMs) unconfirmed.push(id);
  }
  return unconfirmed;
}

/** Is the heartbeat fresh within the staleness window? (BLIND — mirrors the route.) */
export function heartbeatFresh(hb: NeedsYouWatcherHeartbeat | null, now: number, windowMs: number): boolean {
  if (!hb) return false;
  const t = Date.parse(hb.last_beat_at);
  return !Number.isNaN(t) && now - t <= windowMs;
}

// ── Thin I/O wrappers (shell + fs) ──────────────────────────────────────────

/** Run a `decision-ledger` subcommand, returning stdout ("" on failure). */
export function runDecisionLedger(args: string[]): string {
  try {
    const r = spawnSync("decision-ledger", args, {
      encoding: "utf-8",
      timeout: 15_000,
      maxBuffer: LEDGER_MAX_BUFFER,
    });
    if (r.status !== 0) return "";
    return typeof r.stdout === "string" ? r.stdout : "";
  } catch {
    return "";
  }
}

/**
 * Build the thread-index map by pre-fetching `replay` for each candidate thread
 * + cell. FRESHNESS-SAFE-READ: a thread whose replay shell FAILS is stored as
 * `undefined` so the core's index returns `undefined` ⇒ that item surfaces
 * UNCERTAIN (never silently dropped).
 */
export function prefetchThreadIndex(threadKeys: readonly string[]): Map<string, LedgerEvent[] | undefined> {
  const map = new Map<string, LedgerEvent[] | undefined>();
  for (const key of new Set(threadKeys)) {
    const out = runDecisionLedger(["replay", "--thread-id", key, "--json"]);
    map.set(key, out ? parseReplay(out) : undefined);
  }
  return map;
}

/** Read + project the driver registry into `DriverRow[]` (empty on any failure). */
export function readDriverRegistry(): DriverRow[] {
  const raw = readJsonFile<{ drivers?: Record<string, Record<string, unknown>> }>(registryPath(), {});
  const drivers = raw.drivers ?? {};
  const rows: DriverRow[] = [];
  for (const [name, d] of Object.entries(drivers)) {
    rows.push({
      name: String(d["real_name"] ?? name),
      runtime: str(d["runtime"]),
      cell: str(d["cell"]) || null,
      domain: str(d["domain"]) || null,
      state: str(d["state"]) || null,
      last_seen: str(d["last_seen"]) || null,
    });
  }
  return rows;
}

/** herald-send a single message; true iff exit 0. Deduped by caller. */
export function heraldSend(text: string): boolean {
  try {
    const r = spawnSync("herald-send", [text], { encoding: "utf-8", timeout: 15_000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** Write the feed file atomically (tmp + rename). */
export function writeFeed(feed: NeedsYouFeed): void {
  writeJsonFile(feedPath(), feed);
}

/** Write the liveness heartbeat file atomically. */
export function writeHeartbeat(hb: NeedsYouWatcherHeartbeat): void {
  writeJsonFile(heartbeatPath(), hb);
}

/** Read the delivery receipts file (empty on missing/invalid). */
export function readReceipts(): DeliveryReceipt[] {
  return readJsonFile<DeliveryReceipt[]>(receiptPath(), []);
}

// ── The tick + the standing loop ────────────────────────────────────────────

/** In-memory watcher state carried across ticks (dedupe + delivery-proof). */
export interface WatcherState {
  pushed: Set<string>;
  pushLedger: PushLedger;
}

export function createWatcherState(): WatcherState {
  return { pushed: new Set(), pushLedger: {} };
}

/**
 * One watcher tick: read → compute (pure core) → write feed + heartbeat →
 * herald-push newly-detected → delivery-proof escalate. `now` + `deps` injected
 * so the tick itself is testable with mocked I/O.
 */
export function runTick(state: WatcherState, now: number, deps: MustActDeps, paneState: PaneRow[] = []): NeedsYouFeed {
  // READ — candidate source (the closes-edge-honoring projection).
  const openDecisions = parseOpenDecisions(runDecisionLedger(["open-decisions", "--json"]));
  const ledgerHead = openDecisions.reduce((max, e) => Math.max(max, ordinal(e.event_id)), 0);

  // Prefetch the supersede-scan thread index for every candidate thread + cell.
  const threadKeys = openDecisions.flatMap((e) => [e.thread_id, cellOf(e)].filter((k): k is string => !!k));
  const indexMap = prefetchThreadIndex(threadKeys);
  const ledgerThreadIndex = (k: string) => indexMap.get(k);

  const driverRegistry = readDriverRegistry();

  // COMPUTE — the pure core.
  const items = computeMustActSet({
    openDecisions,
    ledgerThreadIndex,
    driverRegistry,
    paneState,
    now,
    ledgerHead: ledgerHead > 0 ? `dl-${ledgerHead}` : "dl-0",
    deps,
  });

  const feed: NeedsYouFeed = {
    schema_version: "surface-contract-v0",
    computed_at: new Date(now).toISOString(),
    ledger_head: ledgerHead > 0 ? `dl-${ledgerHead}` : "dl-0",
    items,
  };

  // WRITE — feed + heartbeat (atomic).
  writeFeed(feed);
  writeHeartbeat({ last_beat_at: new Date(now).toISOString(), watcher_pid: process.pid, cadence_ms: WATCHER_CADENCE_MS });

  // PUSH — herald-send newly-detected operator-band items (deduped).
  const toPush = newlyDetectedIds(items, state.pushed);
  for (const id of toPush) {
    const item = items.find((i) => i.id === id);
    if (!item) continue;
    if (heraldSend(pushText(item))) {
      state.pushed.add(id);
      state.pushLedger[id] = now;
    }
  }

  // PROVE — delivery-proof: escalate pushed-but-unconfirmed past the window.
  const bandIds = new Set(items.filter((i) => i.lane !== "crew-lane").map((i) => i.id));
  const unconfirmed = decideDeliveryEscalation(bandIds, state.pushLedger, readReceipts(), now);
  if (unconfirmed.length > 0) {
    heraldSend(`⚠ needs-you band: ${unconfirmed.length} pushed must-act(s) UNCONFIRMED (delivery not proven). Open the dashboard.`);
  }
  // Drop ledger entries for items no longer on the band (resolved/gone).
  for (const id of Object.keys(state.pushLedger)) {
    if (!bandIds.has(id)) delete state.pushLedger[id];
  }

  return feed;
}

/** The herald push text for a newly-detected item (operator-language + action). */
export function pushText(item: NeedsYouItem): string {
  const flag = item.halt_tier ? "🛑 " : item.uncertain ? "❓ " : "";
  return `${flag}Needs you: ${item.label}\n→ ${item.action}`;
}

/**
 * The standing loop entry: tick every `cadenceMs`, forever. Keep it thin — all
 * logic is in `runTick` + the pure core. `deps` supplies the role-resolver +
 * curation hooks (Stage 3 wires the role-registry-backed resolver).
 */
export async function runWatcherLoop(deps: MustActDeps, cadenceMs: number = WATCHER_CADENCE_MS): Promise<void> {
  const state = createWatcherState();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      runTick(state, Date.now(), deps);
    } catch (err) {
      // A tick failure must not kill the standing watcher — log + continue so
      // the heartbeat resumes next tick (a dead watcher is the recursive failure).
      process.stderr.write(`[needs-you-watcher] tick error: ${String(err)}\n`);
    }
    await sleep(cadenceMs);
  }
}

// ── tiny helpers ─────────────────────────────────────────────────────────────

function safeJsonArray(stdout: string): Record<string, unknown>[] {
  if (!stdout.trim()) return [];
  try {
    const v = JSON.parse(stdout);
    return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
  } catch {
    return [];
  }
}

function cellOf(e: LedgerEvent): string | null {
  const cid = e.payload?.["cell_id"];
  return typeof cid === "string" && cid.length > 0 ? cid : null;
}

function ordinal(eventId: string): number {
  const m = eventId.match(/^dl-(\d+)$/);
  return m ? Number(m[1]) : 0;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
