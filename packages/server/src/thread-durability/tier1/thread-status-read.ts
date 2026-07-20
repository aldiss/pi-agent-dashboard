/**
 * Tier-1 read-only visibility — the per-thread CURRENT-STATUS read (design
 * v0.3 Tier-1 §"What Tier-1 IS" #2; Alice's A5 order).
 *
 * The ONE authoritative status read:
 *
 *     current outbox row → authoritative TerminalProof → unknown/corrupt fail-loud
 *
 * and NOTHING else. This module NEVER infers status from history — it selects
 * the current row by a COMMITTED field (`updated_at`, tie-broken by
 * `delivery_id`) and reads THAT ONE row's committed `{state, delivered}`. A
 * thread's progression, its transition log, its prior attempts — none of it is
 * consulted. The row (the durable outbox, the source of truth) already decided.
 *
 * Graceful degrade (Tier-1 additive-safety): where the core's outbox/claim
 * substrate is absent or still mid-build (0 worktree hits is normal today), the
 * read returns `building` — "not yet wired", never a fabricated status. A read
 * error (uncreated outbox dir) degrades the same way.
 *
 * Fail-loud: a row whose committed shape violates a core invariant (unknown
 * `state`, `delivered` set without the `executed` terminal, a negative/NaN
 * revision or attempt) is surfaced as `corrupt` with a machine-readable reason
 * — NEVER silently coerced to a plausible status.
 *
 * READ-ONLY: this reads the durable outbox via a minimal `listByThread` seam.
 * It takes no lock, drives no transition, writes nothing, and confers no
 * recovery/dedup/terminal authority. The B2 `OutboxStore` satisfies the seam
 * nominally; tests stub it. It does NOT wire `server.ts` (activation-tier).
 *
 * TerminalProof: the terminal `delivered` barrier written by the committed
 * `markDelivered` / `reconcileAccepted` / `recover:terminalize` paths — the
 * monotonic `delivered:true` at `state:"executed"`. This module only READS that
 * barrier; it is the same proof the terminalizer (`terminalize.ts`) produces.
 */

import type {
  DeliveryState,
  OutboxEntry,
} from "@blackbelt-technology/pi-dashboard-shared/thread-durability/index.js";

/** The six committed delivery states (the corruption whitelist). */
const KNOWN_STATES: ReadonlySet<DeliveryState> = new Set<DeliveryState>([
  "injecting",
  "queued_executing",
  "observed",
  "accepted",
  "executed",
  "failed",
]);

/**
 * The Tier-1 status KIND for a delivery/thread. Deliberately coarse — Tier-1
 * DISPLAYS the current barrier, it does not re-derive the six-state machine:
 *
 *  - `building`   — no durable row yet (substrate absent / mid-build) OR the
 *                   thread has no outbox rows. "Not yet wired." Graceful-degrade.
 *  - `in_flight`  — a current row exists at a non-terminal, non-failed state
 *                   (`injecting`/`queued_executing`/`observed`/`accepted`, or
 *                   `executed` BEFORE the `delivered` barrier). Still in motion.
 *  - `delivered`  — the authoritative TerminalProof: `delivered:true` at
 *                   `state:"executed"`. Terminal, monotonic, never regresses.
 *  - `failed`     — the current row's claim is terminally `failed` (a correlated
 *                   failure result). Terminal.
 *  - `corrupt`    — fail-loud: the current row violates a core invariant. Never
 *                   coerced to a plausible status; surfaced with a reason.
 */
export type ThreadStatusKind =
  | "building"
  | "in_flight"
  | "delivered"
  | "failed"
  | "corrupt";

/** A machine-readable reason for a `building` or `corrupt` status. */
export type ThreadStatusReason =
  | "substrate_absent" // the outbox dir/read is unavailable (mid-build)
  | "no_rows" // the substrate exists but this thread has no rows yet
  | "unknown_state" // row.state ∉ the six committed states
  | "delivered_without_executed" // delivered:true but state≠executed (barrier invariant)
  | "invalid_revision" // revision not a finite ≥0 integer
  | "invalid_attempt"; // attempt not a finite ≥0 integer

/** The current-status projection of one thread (read-only, no history). */
export interface ThreadStatus {
  thread_id: string;
  kind: ThreadStatusKind;
  /** The delivery_id of the current row the status was read from (if any). */
  delivery_id?: string;
  /** The current row's committed state (absent when `building` with no row). */
  state?: DeliveryState;
  /** The current row's committed revision (absent when `building`/`corrupt`). */
  revision?: number;
  /** Present for `building`/`corrupt` — why the read degraded / failed loud. */
  reason?: ThreadStatusReason;
}

/**
 * Validate one durable row's COMMITTED shape against the core invariants. A
 * violation is fail-loud (`corrupt` + reason), never a silent coercion. Returns
 * null when the row is well-formed.
 *
 * This checks ONLY structural invariants the committed store maintains — it
 * does NOT re-run the state machine or judge whether a transition was legal
 * (that authority lives in the core, not in a read projection).
 */
function corruptionReason(row: OutboxEntry): ThreadStatusReason | null {
  if (!KNOWN_STATES.has(row.state)) return "unknown_state";
  // The TerminalProof invariant: `delivered` is the barrier written only at the
  // `executed` terminal (markDelivered/reconcileAccepted/recover). A row with
  // `delivered:true` at any other state is a corrupt barrier — fail loud.
  if (row.delivered === true && row.state !== "executed") {
    return "delivered_without_executed";
  }
  if (!Number.isInteger(row.revision) || row.revision < 0) return "invalid_revision";
  if (!Number.isInteger(row.attempt) || row.attempt < 0) return "invalid_attempt";
  return null;
}

/**
 * Derive the authoritative status of ONE durable row (Alice's A5 order applied
 * to a single row): validate the committed shape (fail-loud on violation), then
 * read the TerminalProof barrier, then the terminal `failed` claim, else it is
 * in-flight. NEVER consults any other row or any history.
 */
export function deriveDeliveryStatus(row: OutboxEntry): ThreadStatus {
  const corrupt = corruptionReason(row);
  if (corrupt !== null) {
    return { thread_id: row.thread_id, kind: "corrupt", delivery_id: row.delivery_id, reason: corrupt };
  }
  // Authoritative TerminalProof: delivered barrier at the executed terminal.
  if (row.delivered === true && row.state === "executed") {
    return {
      thread_id: row.thread_id,
      kind: "delivered",
      delivery_id: row.delivery_id,
      state: row.state,
      revision: row.revision,
    };
  }
  // Terminal failure claim (a correlated failure result — re-inject-safe, but
  // the CURRENT row is failed until a re-arm writes a new one).
  if (row.state === "failed") {
    return {
      thread_id: row.thread_id,
      kind: "failed",
      delivery_id: row.delivery_id,
      state: row.state,
      revision: row.revision,
    };
  }
  // Everything else (injecting/queued_executing/observed/accepted, or executed
  // BEFORE the delivered barrier) is still in motion.
  return {
    thread_id: row.thread_id,
    kind: "in_flight",
    delivery_id: row.delivery_id,
    state: row.state,
    revision: row.revision,
  };
}

/**
 * Select the CURRENT row of a thread from its durable rows: the row with the
 * greatest committed `updated_at`, ties broken by `delivery_id` (lexicographic,
 * deterministic). This is a SELECTION by a committed field — it does NOT
 * aggregate, merge, or infer across rows. Returns null for an empty set.
 *
 * Rationale: a re-arm (`markAttempting`) reuses the SAME `delivery_id` and bumps
 * `updated_at`, so the freshest `updated_at` is the live delivery; distinct
 * `delivery_id`s are distinct messages and the freshest is "current" for the
 * thread's at-a-glance status. The full per-delivery breakdown is the B4/B5
 * read-path (`snapshotForThread`), not this at-a-glance status.
 */
export function selectCurrentRow(rows: readonly OutboxEntry[]): OutboxEntry | null {
  let current: OutboxEntry | null = null;
  for (const row of rows) {
    if (current === null) {
      current = row;
      continue;
    }
    if (
      row.updated_at > current.updated_at ||
      (row.updated_at === current.updated_at && row.delivery_id > current.delivery_id)
    ) {
      current = row;
    }
  }
  return current;
}

/**
 * Derive a thread's current status from its durable rows (pure). `null` rows =
 * the substrate is absent/mid-build → `building` (graceful-degrade). An empty
 * array = the substrate exists but the thread has no rows yet → `building`
 * (`no_rows`). Otherwise select the current row and read ITS status.
 */
export function deriveThreadStatus(
  thread_id: string,
  rows: readonly OutboxEntry[] | null,
): ThreadStatus {
  if (rows === null) {
    return { thread_id, kind: "building", reason: "substrate_absent" };
  }
  const current = selectCurrentRow(rows);
  if (current === null) {
    return { thread_id, kind: "building", reason: "no_rows" };
  }
  return deriveDeliveryStatus(current);
}

/**
 * The minimal read-only store seam the status read consults: list the durable
 * rows for one thread. The committed B2 `OutboxStore.listByThread` satisfies
 * this nominally; tests stub it. READ-ONLY — no mutation surface is referenced.
 */
export interface ThreadRowSource {
  listByThread(thread_id: string): OutboxEntry[];
}

/**
 * Read a thread's authoritative current status from the durable outbox
 * (read-only). A throw from the source (uncreated outbox dir / mid-build
 * substrate) degrades to `building` — the read NEVER propagates an I/O failure
 * as a fabricated status, and NEVER falls back to history.
 */
export function readThreadStatus(source: ThreadRowSource, thread_id: string): ThreadStatus {
  let rows: OutboxEntry[] | null;
  try {
    rows = source.listByThread(thread_id);
  } catch {
    // Substrate absent / outbox dir uncreated / mid-build → graceful-degrade.
    rows = null;
  }
  return deriveThreadStatus(thread_id, rows);
}
