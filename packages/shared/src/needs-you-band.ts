/**
 * "Needs you" band — SURFACE-CONTRACT-v0 shared types + config constants.
 *
 * The band surfaces the worth-based, ledger-derived must-act set: the handful
 * of things genuinely parked on the operator, curated out of a ~2168-open
 * ledger that is ~95% never-closed informational cruft. This module is the
 * single source of truth for the data model shared across all three tiers
 * (watcher → server route → client hook/component).
 *
 * TWO LOAD-BEARING SPLITS the rest of the stack depends on:
 *
 *   1. `kind` (surface CLASS, operator-facing) ≠ `source` (ledger|derived,
 *      provenance). A single `kind` can arrive from a ledger event-type OR a
 *      derived driver-state. Auditor-7's E2E binds PER-KIND and the client
 *      renders PER-KIND, so the five kinds must stay DISTINCT — never collapse
 *      to one bucket, never fold `runaway-cost` into `stalled-deliverable`.
 *
 *   2. `label` (operator-language, legibility-gated, ≤ MAX_LABEL_CHARS) ≠
 *      `action` (owner-supplied exact next step, UNCAPPED) ≠ `drilldown` (where
 *      the jargon — dl-ids, thread-ids, raw summary — is allowed to live). The
 *      label is GENERATED per-kind (never a raw `event.summary` pass-through);
 *      see `needs-you-label.ts`.
 *
 * BROWSER-SAFE: no `node:` imports. The client imports these types + the pure
 * `stableItemId` helper directly. Homedir path-resolution (which needs
 * `node:os`) lives in the server route + watcher, keyed off the env-var-name
 * and default-basename constants exported here.
 *
 * Cell: pi-agent-dashboard-needs-you-band. Surface: SURFACE-CONTRACT-v0.
 */

// ── The surface taxonomy (Joan-ratified 2026-07-18) ────────────────────────

/**
 * `kind` = the operator-facing SURFACE CLASS. DISTINCT per Auditor-7's per-kind
 * E2E bind + per-kind client render — never collapse.
 *
 *   - `parked-decision`     C1: a genuinely-open operator-decision parked ON
 *                           the operator (reversible → may drive-with-default).
 *                           NOT the production-gate HALT case — that is now
 *                           `production-held` (below).
 *   - `production-held`     C1 HALT-tier: a real production action held on the
 *                           operator's explicit decision (production-gate).
 *                           `halt_tier=true` — recommend-as-default + EXPLICIT
 *                           operator nod only, NEVER auto-fire.
 *   - `stalled-deliverable` C2: a driver/deliverable stalled, needs an operator
 *                           action (terminal-blocked / derived stalled /
 *                           idle-mid-task).
 *   - `phantom-hold`        C4: a claimed hold that never fired, blocking real
 *                           work.
 *   - `commitment-drop`     C5: an open prior-tenure commitment never
 *                           discharged (cross-tenure).
 *   - `runaway-cost`        DISTINCT worth-signal (spend-intervention),
 *                           `source.origin=derived`. Joan-ratified distinct;
 *                           NEVER fold into `stalled-deliverable`.
 *
 * NOT surfaced kinds (do NOT add): C3 fail-silent-send IS the band's own
 * delivery-proof (Rule 5); C6 resource-leak is self-heal/reaper.
 *
 * `production-held` LANDED as a distinct kind (Joan×Auditor A5-FINAL, ratified
 * 2026-07-18) — split from the interim `parked-decision` + `halt_tier` shape.
 * Source→kind mapping (watcher, St2): `production-gate → production-held`;
 * genuinely-open `operator-decision → parked-decision`.
 */
export type NeedsYouKind =
  | "parked-decision"
  | "production-held"
  | "stalled-deliverable"
  | "phantom-hold"
  | "commitment-drop"
  | "runaway-cost";

/** All six kinds, frozen — for exhaustive iteration in tests + client render. */
export const NEEDS_YOU_KINDS: readonly NeedsYouKind[] = Object.freeze([
  "parked-decision",
  "production-held",
  "stalled-deliverable",
  "phantom-hold",
  "commitment-drop",
  "runaway-cost",
]);

/**
 * Render LANE (§3 operator-action gate — Auditor-8 dl-9218 ASYMMETRIC ruling).
 * Composes with the band's 3-tier render:
 *   - `operator-band` + `uncertain=false` → the MAIN must-act band.
 *   - `operator-band` + `uncertain=true`  → the lower-tier "possibly-needs-you /
 *     UNKNOWN-LOUD" band (surfaced, flagged — NEVER dropped).
 *   - `crew-lane`                          → the crew self-heal lane (routed OFF
 *     the operator band). The ONLY thing that lands here is PROVABLY
 *     crew-self-healable (no operator-action AND provable crew-self-heal).
 *
 * COVERAGE-CONTRACT: `crew-lane` is a RENDER-ROUTING decision, NOT a detection
 * removal — every worth-trigger is still DETECTED + tested + emitted.
 */
export type Lane = "operator-band" | "crew-lane";

/**
 * `source` = provenance, SEPARATE from `kind`. A kind can come from a ledger
 * event-type OR a derived driver-state. The type-filter (A2) gates on
 * `ledger_type`; the worth-detectors gate on `derived_state`.
 */
export interface NeedsYouSource {
  origin: "ledger" | "derived";
  /** Set when `origin=ledger`. The authoritative must-act event types (A1/A2). */
  ledger_type?: "production-gate" | "terminal-blocked" | "operator-decision" | "operator-ratify";
  /** Set when `origin=derived`. The worth-trigger driver-state (A3/§4a.3). */
  derived_state?: "stalled" | "idle" | "runaway";
  /** `dl-N` when `origin=ledger`. */
  event_id?: string;
  thread_id?: string;
  cell_id?: string;
}

/**
 * A single must-act item, in operator-facing SURFACE-CONTRACT-v0 shape.
 *
 * INVARIANTS:
 *   - `label` is GENERATED per-kind + passes `isLegibleLabel` (≤ MAX_LABEL_CHARS,
 *     no dl-ids / §-cites / themed-names / version-tags). Jargon lives in
 *     `drilldown`, NEVER in `label`.
 *   - `action` is the owner-supplied exact next step, a verb-phrase, UNCAPPED
 *     (a truncated action is a Rule 4 fail).
 *   - `halt_tier=true` ⇒ production-touch: recommend-as-default + EXPLICIT
 *     operator nod only, NEVER auto-fire.
 *   - `uncertain=true` ⇒ freshness-safe-read could not PROVE current state ⇒
 *     render LOUD-uncertain, NEVER silently drop (fail-safe toward showing).
 */
export interface NeedsYouItem {
  /** Stable id (hash of source) so re-computes dedupe. See `stableItemId`. */
  id: string;
  kind: NeedsYouKind;
  source: NeedsYouSource;
  /** GENERATED per-kind; passes the legibility predicate. Never raw summary. */
  label: string;
  /** The exact correct next action (owner-supplied); verb-phrase; UNCAPPED. */
  action: string;
  /** true ⇒ production-touch: recommend-as-default + EXPLICIT operator nod only. */
  halt_tier: boolean;
  /** true ⇒ state could not be PROVEN current ⇒ render LOUD-uncertain, never drop. */
  uncertain: boolean;
  /**
   * Render lane (§3). `operator-band` (default) surfaces on the operator band
   * (main if `!uncertain`, lower-tier if `uncertain`); `crew-lane` routes OFF
   * the operator band (provably crew-self-healable only). Optional for
   * backward-compat; absent ⇒ treat as `operator-band`.
   */
  lane?: Lane;
  /** ISO — when the watcher last computed/pushed this item. */
  pushed_at: string;
  /** The jargon lives HERE, never in `label`. */
  drilldown: {
    event_id?: string;
    thread_id?: string;
    raw_summary?: string;
  };
}

/** The watcher's feed file (atomic temp+rename write each cadence tick). */
export interface NeedsYouFeed {
  schema_version: "surface-contract-v0";
  /** ISO. */
  computed_at: string;
  /** The `dl-N` head pinned at compute-start (freshness-safe-read anchor). */
  ledger_head: string;
  items: NeedsYouItem[];
}

/** The watcher's liveness heartbeat file (sister to `driver-liveness.ts`). */
export interface NeedsYouWatcherHeartbeat {
  /** ISO. */
  last_beat_at: string;
  watcher_pid: number;
  cadence_ms: number;
}

/**
 * The server → client response. The heartbeat is folded into `watcher_live`,
 * BLIND: `watcher_live` reflects ONLY the heartbeat freshness — it is NEVER
 * inferred from the item contents.
 */
export interface NeedsYouBandResponse {
  items: NeedsYouItem[];
  /** BLIND: is the heartbeat fresh within STALE_WINDOW_MS? Contents-independent. */
  watcher_live: boolean;
  computed_at: string | null;
  ledger_head: string | null;
  /** Set when `watcher_live=false` (e.g. "heartbeat stale: last beat 214s ago"). */
  stale_reason: string | null;
}

// ── Config constants ───────────────────────────────────────────────────────

/**
 * Soft-default label cap (Peggy calibrates on first real labels). A label
 * longer than this triggers REGENERATE-tighter (never mid-string truncation —
 * a cut label is itself illegible). See `needs-you-label.ts`.
 */
export const MAX_LABEL_CHARS = 120;

/**
 * `watcher_live` staleness window. Heartbeat older than this ⇒
 * `watcher_live=false`. The watcher beats every WATCHER_CADENCE_MS (30s), so
 * 90s = three missed beats before the band goes loud-uncertain.
 */
export const STALE_WINDOW_MS = 90_000;

/** The watcher's heartbeat cadence (beats + recomputes every tick). */
export const WATCHER_CADENCE_MS = 30_000;

/** Server-route in-memory cache TTL (mirrors surfaces-routes 5s). */
export const FEED_CACHE_TTL_MS = 5_000;

/**
 * Client poll cadence for `/api/needs-you-band`. Mirrors `useFleetBrief`'s
 * pull rhythm; the loud path is the watcher's herald-push, not this poll.
 */
export const CLIENT_POLL_INTERVAL_MS = 15_000;

// ── Canonical file locations (env-overridable — resolved server-side) ───────
//
// Path RESOLUTION (homedir join + `~` expansion) needs `node:os`/`node:path`
// and therefore lives in the server route + watcher (mirror
// `surfaces-routes.ts#resolveCanonicalPath`). This module — imported by the
// browser client — exports only the env-var NAMES + default BASENAMES so both
// sides agree on the contract without pulling a `node:` dependency into the
// client bundle.

/** Feed file: `~/.pi/orchestration-state/needs-you-must-act-set.json`. */
export const NEEDS_YOU_FEED_ENV = "NEEDS_YOU_MUST_ACT_FILE";
export const NEEDS_YOU_FEED_BASENAME = "needs-you-must-act-set.json";

/** Heartbeat: `~/.pi/orchestration-state/.needs-you-watcher-liveness.json`. */
export const NEEDS_YOU_HEARTBEAT_ENV = "NEEDS_YOU_WATCHER_LIVENESS_FILE";
export const NEEDS_YOU_HEARTBEAT_BASENAME = ".needs-you-watcher-liveness.json";

/** The orchestration-state directory both canonical files live under. */
export const ORCHESTRATION_STATE_DIR_SEGMENTS: readonly string[] = Object.freeze([
  ".pi",
  "orchestration-state",
]);

// ── Pure stable-id helper (browser-safe; no node:crypto) ────────────────────

/**
 * Deterministic stable id for an item, derived from its `source`, so a
 * re-compute of the same underlying must-act dedupes to the same id (the
 * herald-push dedupe key + the client render key both depend on this).
 *
 * Uses FNV-1a — a fast, dependency-free, browser-safe string hash. This id is
 * a DEDUPE key, not a security token, so a non-cryptographic hash is correct
 * (and keeps this module out of `node:crypto`, preserving browser-safety).
 *
 * Identity basis = the provenance-defining fields of `source`, in a fixed
 * order. Two sources that point at the same underlying thing (same ledger
 * event, or same derived driver-state on the same cell) produce the same id.
 */
export function stableItemId(source: NeedsYouSource): string {
  const basis = [
    source.origin,
    source.ledger_type ?? "",
    source.derived_state ?? "",
    source.event_id ?? "",
    source.thread_id ?? "",
    source.cell_id ?? "",
  ].join(" ");
  return `ny-${fnv1a(basis)}`;
}

/** FNV-1a 32-bit, returned as an 8-char lowercase hex string. Pure. */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // 32-bit FNV prime multiply via shifts, kept in unsigned 32-bit space.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
