/**
 * Thread-durability — the shared outbox/seam contract (design v3.6 §C1/§C2/N1).
 *
 * The DURABLE OUTBOX ROW + the recover-evidence resolver interface + the store
 * mutation-input/result shapes, lifted into the shared package so BOTH the
 * server durable store (`packages/server`, the implementation) AND the bridge
 * injection/recovery (`packages/extension`, the caller) import them NOMINALLY
 * from one place. B4 step 1 relocated these out of `packages/server` (which the
 * extension cannot nominally import — extension→server is not a wired path);
 * the prior structural mirrors (`OutboxEntryView`, `RecoverEvidenceResolverView`,
 * `InjectStoreView`, …) are deleted in favor of these.
 *
 * PURE types only — no I/O, no pi runtime. The revision-CAS `ExpectedMutation`
 * + `MutationRejectReason` live in `revision-cas.ts` and are re-exported here
 * for a single seam import surface.
 */

import type {
  AcceptanceFact,
  DeliveryState,
  DurableScanEvidence,
  HolderIdentity,
  HolderLiveness,
  OriginalTuple,
  RecoveryOutcome,
} from "./types.js";
import type { ExpectedMutation, MutationRejectReason } from "./revision-cas.js";

/**
 * The persisted outbox row — a superset of the B1 `DeliveryRecord` (row view)
 * and `Claim` (proof-tracking view). Both run under the SAME per-row lock
 * (N1), so they live in one durable file, not two domains.
 */
export interface OutboxEntry {
  // ── identity / causal fields ──
  delivery_id: string;
  attempt: number;
  thread_id: string;
  holder_session_id: string;
  holder_identity: HolderIdentity;
  holder_epoch: number;
  payload_hash: string;
  entry_id?: string;
  // ── state / concurrency ──
  state: DeliveryState;
  revision: number;
  delivered: boolean;
  updated_at: number;
}

/** Result of a mutation attempt. `ok:false` carries a stable reason code. */
export type MutationResult =
  | { ok: true; entry: OutboxEntry }
  | { ok: false; reason: MutationRejectReason | "not_found" | "illegal_transition" };

/** The fields needed to create/re-arm a row at `injecting` (a fresh attempt). */
export interface AttemptInput {
  delivery_id: string;
  attempt: number;
  thread_id: string;
  holder_session_id: string;
  holder_identity: HolderIdentity;
  holder_epoch: number;
  payload_hash: string;
  entry_id?: string;
}

/** A claim-state transition request: the CAS expectation + optional fields. */
export interface TransitionInput {
  delivery_id: string;
  expected: ExpectedMutation;
  /** Set on `markObserved` — the entry_id derived from the post-persist seam. */
  entry_id?: string;
}

/**
 * The recover-evidence dependency (design §C3.2). The server store owns the
 * claim read + the decision + the reconcile write; the DURABLE SESSION SCAN is
 * bridge-side (B3, `packages/extension/.../recover-evidence.ts`), so it is
 * INJECTED. All three are consulted UNDER the per-row lock.
 */
export interface RecoverEvidenceResolver {
  /** EXACT-identity liveness of the claim's holder (never a bare-PID check). */
  resolveLiveness(entry: OutboxEntry): HolderLiveness;
  /** Durable-scan evidence from the holder's FINAL session (exact-death only). */
  scanEvidence(entry: OutboxEntry): DurableScanEvidence;
  /** Whether the bounded `indeterminate` lease has elapsed (live progress rule). */
  leaseElapsed?(entry: OutboxEntry): boolean;
}

/** Outcome of the store `recover()` — the B1 decision + terminalization flag. */
export interface RecoverResult {
  outcome: RecoveryOutcome;
  /** True iff the store wrote a terminal `delivered` row (delivered_no_redeliver). */
  terminalized: boolean;
  entry: OutboxEntry;
}

/** The result of a store `reconcileAccepted` write path. */
export interface ReconcileStoreResult {
  action: "terminalize" | "fail_loud" | "noop";
  entry: OutboxEntry | null;
}

/** A store surface that can read the current durable row (unlocked, never torn). */
export interface ReadableOutboxStore {
  read(delivery_id: string): OutboxEntry | null;
}

/**
 * The store surface the bridge injection + terminalization drive (the subset
 * of the server `OutboxStore` they call). The concrete server class satisfies
 * this nominally. Kept minimal so the bridge depends only on the transitions
 * it exercises.
 */
export interface InjectableOutboxStore {
  markQueued(input: TransitionInput): Promise<MutationResult>;
  markObserved(input: TransitionInput): Promise<MutationResult>;
  markAccepted(input: TransitionInput): Promise<MutationResult>;
  markExecuted(input: TransitionInput): Promise<MutationResult>;
  markFailed(input: TransitionInput): Promise<MutationResult>;
  reconcileAccepted(
    fact: AcceptanceFact,
    original: OriginalTuple,
  ): Promise<ReconcileStoreResult>;
}

/** Re-exported here so the bridge imports the whole seam from one module. */
export type { ExpectedMutation, MutationRejectReason } from "./revision-cas.js";

/** The delivery `state` values, re-exported for a single seam import. */
export type { DeliveryState } from "./types.js";
