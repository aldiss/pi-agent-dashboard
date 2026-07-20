/**
 * Thread-durability — the durable outbox store (design v3.6 §C1 + §C2 + N1).
 *
 * Server-side, real I/O, built on the B1 pure core (state-machine /
 * revision-cas / reconcile / recovery-decision). ONE serialization domain:
 * EVERY mutation and EVERY claim-state transition runs
 *
 *     acquire per-row lock → read → validate {expected_state,
 *     expected_revision, expected_attempt} (revision-CAS) → atomic durable
 *     write → release
 *
 * All writes funnel through the private {@link OutboxStore.commit}, which
 * ASSERTS the row lock is held before touching disk — the runtime half of the
 * exhaustive-mutation lock build-check (Bert §C1). `recover()` consults the
 * durable proof-tracking claim FIRST (never a volatile/observed signal, never
 * an absent-session-as-non-acceptance while live) and applies B1
 * `decideRecovery`. The durable session-JSONL SCAN is bridge-side (Phase B3),
 * modelled here as an injected {@link RecoverEvidenceResolver} dependency.
 *
 * The global drain lease selects the scanner/attempt-owner only; it NEVER
 * substitutes for the per-row lock (N1).
 */
import fs from "node:fs";
import path from "node:path";

import type {
  AcceptanceFact,
  Claim,
  DeliveryRecord,
  DeliveryState,
  HolderIdentity,
  OriginalTuple,
  OutboxEntry,
  MutationResult,
  AttemptInput,
  TransitionInput,
  RecoverEvidenceResolver,
  RecoverResult,
} from "@blackbelt-technology/pi-dashboard-shared/thread-durability/index.js";
import {
  canTransition,
  decideRecovery,
  reconcileAccepted as reconcileAcceptedPure,
  validateMutation,
} from "@blackbelt-technology/pi-dashboard-shared/thread-durability/index.js";

import { atomicWriteFileSync } from "./atomic-write.js";
import { RowLockManager, type RowLockOpts } from "./row-lock.js";

// The durable outbox row + mutation-input/result shapes + the recover-evidence
// resolver interface now live in the SHARED package (B4 step 1 relocate) so the
// bridge can import them nominally. Re-exported here for existing server call
// sites that import them from this module.
export type {
  OutboxEntry,
  MutationResult,
  AttemptInput,
  TransitionInput,
  RecoverEvidenceResolver,
  RecoverResult,
} from "@blackbelt-technology/pi-dashboard-shared/thread-durability/index.js";

export interface OutboxStoreOpts extends RowLockOpts {
  now?: () => number;
}

/** Thrown by {@link OutboxStore.commit} if a write is attempted lock-free. */
export class LockNotHeldError extends Error {
  constructor(delivery_id: string, op: string) {
    super(`write to delivery_id=${delivery_id} (${op}) attempted WITHOUT the per-row lock`);
    this.name = "LockNotHeldError";
  }
}

export class OutboxStore {
  private readonly outboxDir: string;
  private readonly locks: RowLockManager;
  private readonly now: () => number;

  constructor(outboxDir: string, opts: OutboxStoreOpts = {}) {
    this.outboxDir = outboxDir;
    this.locks = new RowLockManager(outboxDir, opts);
    this.now = opts.now ?? (() => Date.now());
    fs.mkdirSync(outboxDir, { recursive: true });
  }

  // ── paths / projection ────────────────────────────────────────────────

  private entryPath(delivery_id: string): string {
    return path.join(this.outboxDir, `${delivery_id}.json`);
  }

  /** Unlocked read for external inspection. Never torn (atomic rename). */
  read(delivery_id: string): OutboxEntry | null {
    try {
      const raw = fs.readFileSync(this.entryPath(delivery_id), "utf-8");
      return JSON.parse(raw) as OutboxEntry;
    } catch {
      return null;
    }
  }

  /** Project the B1 `DeliveryRecord` (row) view of an entry. */
  static toRecord(e: OutboxEntry): DeliveryRecord {
    return {
      delivery_id: e.delivery_id,
      attempt: e.attempt,
      thread_id: e.thread_id,
      holder_session_id: e.holder_session_id,
      payload_hash: e.payload_hash,
      state: e.state,
      revision: e.revision,
      delivered: e.delivered,
      entry_id: e.entry_id,
      updated_at: e.updated_at,
    };
  }

  /** Project the B1 `Claim` (proof-tracking) view of an entry. */
  static toClaim(e: OutboxEntry): Claim {
    return {
      delivery_id: e.delivery_id,
      attempt: e.attempt,
      thread_id: e.thread_id,
      holder_session_id: e.holder_session_id,
      holder_identity: e.holder_identity,
      holder_epoch: e.holder_epoch,
      payload_hash: e.payload_hash,
      entry_id: e.entry_id,
      state: e.state,
      updated_at: e.updated_at,
    };
  }

  // ── the single lock-guarded write funnel ──────────────────────────────

  /**
   * Run `fn` inside the per-row critical section: acquire → fn → release
   * (release ALWAYS runs, even on throw). This is the ONLY place a lock is
   * taken; every public mutation goes through it.
   */
  private async withLock<T>(
    delivery_id: string,
    fn: () => T,
  ): Promise<T> {
    const handle = await this.locks.acquire(delivery_id);
    try {
      return fn();
    } finally {
      this.locks.release(handle);
    }
  }

  /**
   * The ONLY disk-write path. Asserts the row lock is held THEN atomically
   * writes — so a write can never reach disk outside a critical section. The
   * exhaustive-lock test greps for `atomicWriteFileSync` and asserts it
   * appears only here; this assertion is the runtime backstop.
   */
  private commit(delivery_id: string, entry: OutboxEntry, op: string): OutboxEntry {
    if (!this.locks.isHeldLocally(delivery_id)) {
      throw new LockNotHeldError(delivery_id, op);
    }
    atomicWriteFileSync(this.entryPath(delivery_id), JSON.stringify(entry, null, 2));
    return entry;
  }

  // ── mutations (each: acquire → read → validate → commit → release) ─────

  /**
   * Create a fresh row at `injecting`, or re-arm an existing terminal/failed
   * row for a NEW (strictly-greater) attempt. This is the drain entry point.
   */
  async markAttempting(input: AttemptInput): Promise<MutationResult> {
    return this.withLock(input.delivery_id, () => {
      const current = this.read(input.delivery_id);
      if (current === null) {
        // Fresh row — revision starts at 0.
        const entry: OutboxEntry = {
          delivery_id: input.delivery_id,
          attempt: input.attempt,
          thread_id: input.thread_id,
          holder_session_id: input.holder_session_id,
          holder_identity: input.holder_identity,
          holder_epoch: input.holder_epoch,
          payload_hash: input.payload_hash,
          entry_id: input.entry_id,
          state: "injecting",
          revision: 0,
          delivered: false,
          updated_at: this.now(),
        };
        return { ok: true, entry: this.commit(input.delivery_id, entry, "markAttempting:create") };
      }
      // Re-arm: never past a delivered row; only a strictly-greater attempt.
      if (current.delivered) return { ok: false, reason: "delivered_terminal" };
      if (input.attempt <= current.attempt) return { ok: false, reason: "attempt_mismatch" };
      const entry: OutboxEntry = {
        ...current,
        attempt: input.attempt,
        holder_identity: input.holder_identity,
        holder_epoch: input.holder_epoch,
        payload_hash: input.payload_hash,
        entry_id: input.entry_id,
        state: "injecting",
        revision: current.revision + 1,
        delivered: false,
        updated_at: this.now(),
      };
      return { ok: true, entry: this.commit(input.delivery_id, entry, "markAttempting:rearm") };
    });
  }

  markQueued(input: TransitionInput): Promise<MutationResult> {
    return this.transition(input, "queued_executing", "markQueued");
  }

  markObserved(input: TransitionInput): Promise<MutationResult> {
    return this.transition(input, "observed", "markObserved");
  }

  markAccepted(input: TransitionInput): Promise<MutationResult> {
    return this.transition(input, "accepted", "markAccepted");
  }

  markExecuted(input: TransitionInput): Promise<MutationResult> {
    return this.transition(input, "executed", "markExecuted");
  }

  markFailed(input: TransitionInput): Promise<MutationResult> {
    return this.transition(input, "failed", "markFailed");
  }

  /** Shared claim-state transition: validate CAS + legality, then commit. */
  private transition(
    input: TransitionInput,
    target: DeliveryState,
    op: string,
  ): Promise<MutationResult> {
    return this.withLock(input.delivery_id, () => {
      const current = this.read(input.delivery_id);
      if (current === null) return { ok: false, reason: "not_found" };
      const cas = validateMutation(input.expected, OutboxStore.toRecord(current));
      if (!cas.ok) return { ok: false, reason: cas.reason! };
      if (!canTransition(current.state, target)) {
        return { ok: false, reason: "illegal_transition" };
      }
      const entry: OutboxEntry = {
        ...current,
        state: target,
        entry_id: input.entry_id ?? current.entry_id,
        revision: current.revision + 1,
        updated_at: this.now(),
      };
      return { ok: true, entry: this.commit(input.delivery_id, entry, op) };
    });
  }

  /**
   * Terminalize an `executed` row to `delivered` (monotonic + terminal). The
   * CAS + `validateMutation` reject an already-delivered row (delivered never
   * regresses).
   */
  markDelivered(input: TransitionInput): Promise<MutationResult> {
    return this.withLock(input.delivery_id, () => {
      const current = this.read(input.delivery_id);
      if (current === null) return { ok: false, reason: "not_found" };
      const cas = validateMutation(input.expected, OutboxStore.toRecord(current));
      if (!cas.ok) return { ok: false, reason: cas.reason! };
      if (current.state !== "executed") return { ok: false, reason: "illegal_transition" };
      const entry: OutboxEntry = {
        ...current,
        delivered: true,
        revision: current.revision + 1,
        updated_at: this.now(),
      };
      return { ok: true, entry: this.commit(input.delivery_id, entry, "markDelivered") };
    });
  }

  /**
   * Reconcile a durable acceptance fact against the current row (B1
   * `reconcileAccepted`), under the per-row lock. `terminalize` → write a
   * `delivered` row at the returned revision; `fail_loud` → retain (no write);
   * `noop` → no write.
   */
  reconcileAccepted(fact: AcceptanceFact, original: OriginalTuple): Promise<{
    action: "terminalize" | "fail_loud" | "noop";
    entry: OutboxEntry | null;
  }> {
    return this.withLock(fact.delivery_id, () => {
      const current = this.read(fact.delivery_id);
      if (current === null) return { action: "noop" as const, entry: null };
      const res = reconcileAcceptedPure(fact, original, OutboxStore.toRecord(current));
      if (res.action === "terminalize") {
        const entry: OutboxEntry = {
          ...current,
          state: "executed",
          delivered: true,
          revision: res.newRevision!,
          updated_at: this.now(),
        };
        return { action: "terminalize" as const, entry: this.commit(fact.delivery_id, entry, "reconcileAccepted") };
      }
      // fail_loud + noop: RETAIN the row untouched (never silently deliver).
      return { action: res.action, entry: current };
    });
  }

  /**
   * Recover a (possibly lease-expired) row. Reads the durable claim FIRST,
   * feeds B1 `decideRecovery`, and applies the outcome UNDER the lock:
   *  - `delivered_no_redeliver` → terminalize (durable execution proven).
   *  - everything else (`redeliver_once` / `hold` / `operator_block` /
   *    `fail_loud`) → decision only; the row is RETAINED for the caller
   *    (B3 re-arms via `markAttempting`; A5/operator surfaces block/fail).
   * NEVER re-drains on a volatile signal; NEVER treats an absent session as
   * non-acceptance while live (that asymmetry lives in `decideRecovery`).
   */
  recover(delivery_id: string, resolver: RecoverEvidenceResolver): Promise<RecoverResult> {
    return this.withLock(delivery_id, () => {
      const current = this.read(delivery_id);
      if (current === null) {
        throw new Error(`recover: no row for delivery_id=${delivery_id}`);
      }
      const claim = OutboxStore.toClaim(current);
      const liveness = resolver.resolveLiveness(current);
      const evidence = resolver.scanEvidence(current);
      const leaseElapsed = resolver.leaseElapsed?.(current) ?? false;
      const outcome = decideRecovery(claim, liveness, evidence, leaseElapsed);

      if (outcome === "delivered_no_redeliver" && !current.delivered) {
        const entry: OutboxEntry = {
          ...current,
          state: "executed",
          delivered: true,
          revision: current.revision + 1,
          updated_at: this.now(),
        };
        return {
          outcome,
          terminalized: true,
          entry: this.commit(delivery_id, entry, "recover:terminalize"),
        };
      }
      return { outcome, terminalized: false, entry: current };
    });
  }

  /**
   * GC a terminal (`delivered`) row older than `retentionMs`. Under the lock,
   * so a GC never races a live mutation. Returns true if the row was removed.
   */
  gc(delivery_id: string, retentionMs: number): Promise<boolean> {
    return this.withLock(delivery_id, () => {
      const current = this.read(delivery_id);
      if (current === null) return false;
      if (!current.delivered) return false;
      if (this.now() - current.updated_at < retentionMs) return false;
      try {
        fs.unlinkSync(this.entryPath(delivery_id));
        return true;
      } catch {
        return false;
      }
    });
  }

  /** Test/introspection: is the row lock currently held by this store? */
  isLockHeld(delivery_id: string): boolean {
    return this.locks.isHeldLocally(delivery_id);
  }

  /**
   * List every durable outbox row (unlocked snapshot; the outbox is the source
   * of truth). Reads each `*.json` entry file in the outbox dir. A row being
   * mutated concurrently is never torn (atomic rename) — a listing sees either
   * its old or new revision, never a partial write. Malformed/half-deleted
   * files are skipped. Order is unspecified — callers sort as needed.
   */
  list(): OutboxEntry[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.outboxDir);
    } catch {
      return [];
    }
    const out: OutboxEntry[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue; // skip .lock dirs + tmp files
      const deliveryId = name.slice(0, -".json".length);
      const row = this.read(deliveryId);
      if (row !== null) out.push(row);
    }
    return out;
  }

  /** List the durable rows for one `thread_id` (the thread-view + A5 replay). */
  listByThread(thread_id: string): OutboxEntry[] {
    return this.list().filter((r) => r.thread_id === thread_id);
  }
}
