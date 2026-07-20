/**
 * Thread-durability bridge — the injection primitive (design v3.6 §C3.1).
 *
 * `injectDelivery` drives ONE delivery through the proof-tracking claim
 * sequence, wiring the B2 durable store to the REAL pi 0.80.3 executing API:
 *
 *   1. `injecting`         — intent (the row is created/re-armed by the caller;
 *                            this primitive begins at a ready `injecting` row).
 *   2. `queued_executing`  — write+fsync BEFORE the pi call (Bert ordering):
 *                            "may cross / dispatching", a conservative upper
 *                            bound, NOT proof-of-acceptance.
 *   3. INJECT               — `pi.sendMessage({customType:"thread_delivery",
 *                            content, details:{delivery_id, thread_id, attempt,
 *                            holder_epoch}}, idle ? {triggerTurn:true} :
 *                            {deliverAs:"followUp"})`. NEVER the bare append.
 *                            Wrapped in a bridge-owned error boundary holding
 *                            the delivery tuple.
 *   4. `observed`           — the post-persist seam (`pi.on("message_end")` +
 *                            durable scan for `details.delivery_id`) yields the
 *                            `entry_id`. Runtime-local, not yet durable.
 *   5. `accepted`           — the entry is proven durable in the session JSONL.
 *   6. `executed`           — `pi.on("turn_end")` corroborated by a persisted
 *                            assistant child → `store.reconcileAccepted`.
 *
 * A bounded `indeterminate` lease (design §C3.1 step 7) guarantees the await
 * never hangs forever — on timeout the outcome is `indeterminate` (the caller
 * surfaces an operator-visible block; never a silent infinite hold).
 *
 * GROUNDED: the `pi.sendMessage(triggerTurn|deliverAs)` surface is the real pi
 * 0.80.3 `ExtensionAPI` (`extensions/types.d.ts:290`); the post-persist seam
 * (`message_end` + JSONL scan; no `entry_persisted` in 0.80.3) and the
 * executed-signal (`turn_end` + persisted assistant child) were verified
 * own-hand by `__grounding__/run-the-api-probe.mjs`.
 *
 * This is the injection PRIMITIVE. It is INERT until a HELD drain loop (which
 * resolves the holder via Joan's A4/B3 and routes a real prompt) calls it. This
 * file implements NO holder-resolution, NO reassign, NO 3-type landing, NO live
 * drain loop. `holder_epoch` is CARRIED in details, NOT gated on (death-only v1).
 */

import type { DurableScanEvidence } from "@blackbelt-technology/pi-dashboard-shared/thread-durability/index.js";
import type { OutboxEntryView } from "./recover-evidence.js";
import type { DeliveryStateEvent, DeliveryStateSink } from "./delivery-state-channel.js";

// ── the real pi executing surface (grounded on ExtensionAPI 0.80.3) ─────────

/** The `content` of a `thread_delivery` custom message. */
export type DeliveryContent = string;

/** The self-identifying `details` every `thread_delivery` entry carries. */
export interface ThreadDeliveryDetails {
  delivery_id: string;
  thread_id: string;
  attempt: number;
  /** Carried for ordering/staleness + as the v0.5+ fence token; NOT gated in v1. */
  holder_epoch: number;
}

/** Options accepted by the real `pi.sendMessage` (types.d.ts:290). */
export interface SendMessageOptions {
  triggerTurn?: boolean;
  deliverAs?: "steer" | "followUp" | "nextTurn";
}

/**
 * The minimal pi handle the injection needs — the exact 0.80.3 executing API.
 * `sendMessage` is fire-and-forget `Promise<void>` (its async rejection reaches
 * a generic uncorrelated `send_message` error — the E2 OPEN dependency).
 */
export interface PiInjectHandle {
  sendMessage(
    message: {
      customType: "thread_delivery";
      content: DeliveryContent;
      display: boolean;
      details: ThreadDeliveryDetails;
    },
    options?: SendMessageOptions,
  ): Promise<void> | void;
  on(event: "message_end" | "turn_end", handler: (payload: unknown) => void): void;
  off?(event: "message_end" | "turn_end", handler: (payload: unknown) => void): void;
}

// ── the store surface the injection drives (structural mirror of B2) ─────────
//
// PACKAGING NOTE: like `recover-evidence.ts`, the B2 store lives in
// `packages/server` (no `exports` field, no tsconfig `references` edge from
// `packages/extension`), so this declares the needed surface STRUCTURALLY. The
// object B2 passes at the real (held) call site satisfies it by structural
// typing.

/** The CAS expectation each transition asserts (mirror of B2 `ExpectedMutation`). */
export interface ExpectedMutationView {
  expected_revision: number;
  expected_attempt: number;
  expected_state: OutboxStateView;
}

export type OutboxStateView =
  | "injecting"
  | "queued_executing"
  | "observed"
  | "accepted"
  | "executed"
  | "failed";

export interface OutboxRowView extends OutboxEntryView {
  state: OutboxStateView;
  revision: number;
  thread_id: string;
  holder_epoch: number;
}

export type TransitionResultView =
  | { ok: true; entry: OutboxRowView }
  | { ok: false; reason: string };

/** The store methods `injectDelivery` calls (mirror of B2 `OutboxStore`). */
export interface InjectStoreView {
  markQueued(input: { delivery_id: string; expected: ExpectedMutationView }): Promise<TransitionResultView>;
  markObserved(input: { delivery_id: string; expected: ExpectedMutationView; entry_id?: string }): Promise<TransitionResultView>;
  markAccepted(input: { delivery_id: string; expected: ExpectedMutationView }): Promise<TransitionResultView>;
  markFailed(input: { delivery_id: string; expected: ExpectedMutationView }): Promise<TransitionResultView>;
  reconcileAccepted(
    fact: {
      delivery_id: string;
      attempt: number;
      thread_id: string;
      holder_session_id: string;
      entry_id: string;
      payload_hash: string;
      accepted_at: number;
      executed_at?: number;
    },
    original: { delivery_id: string; attempt: number; holder_session_id: string; payload_hash: string },
  ): Promise<{ action: "terminalize" | "fail_loud" | "noop"; entry: OutboxRowView | null }>;
}

// ── the E2 correlated-failure adapter (NARROW OPEN dependency) ──────────────

/**
 * The delivery-correlated FAILURE adapter (design §C3.3 — the E2 narrow OPEN
 * dependency). `pi.sendMessage`'s async rejection is uncorrelated (a generic
 * `send_message` error with NO `delivery_id`), so a delivery-keyed failure is
 * NOT recoverable from the public call. This interface names that surface; if
 * a bridge-side correlated-failure boundary exists it is wired, else `failed`
 * fast-path is absent and never-drop still holds (bounded lease → block →
 * exact-death re-delivery). v1 does NOT depend on it.
 */
export interface CorrelatedFailureAdapter {
  /** Register a callback for a delivery-correlated failure, keyed by delivery_id. */
  onFailure(delivery_id: string, cb: (error: unknown) => void): () => void;
}

// ── the injection result ─────────────────────────────────────────────────────

export type InjectOutcome =
  | "observed" // seam saw the entry (runtime-local)
  | "accepted" // entry proven durable
  | "executed" // correlated assistant turn → reconciled to delivered
  | "failed" // correlated failure (adapter) → claim cleared, re-inject safe
  | "indeterminate"; // bounded lease elapsed with no correlated progress

export interface InjectResult {
  outcome: InjectOutcome;
  entry_id?: string;
  /** The claim's terminal/newest row after the sequence (for the caller). */
  row?: OutboxRowView;
}

export interface InjectDeps {
  pi: PiInjectHandle;
  store: InjectStoreView;
  /** Is the holder idle? idle → triggerTurn; streaming → deliverAs:followUp. */
  holderIsIdle: boolean;
  /** Scan the holder's durable session JSONL → evidence (from recover-evidence). */
  scan: (deliveryId: string, attempt: number, entryIdHint?: string) => {
    entryDurable: boolean;
    entryId?: string;
    evidence: DurableScanEvidence;
  };
  /** Bounded indeterminate lease in ms (never an infinite hold). */
  leaseMs: number;
  /** Injectable clock/timer (tests). */
  now?: () => number;
  setTimer?: (cb: () => void, ms: number) => { cancel: () => void };
  /** Optional E2 correlated-failure adapter (narrow OPEN dep). */
  failureAdapter?: CorrelatedFailureAdapter;
  /** Optional sink for the delivery-state channel (A5 / Phase B4). */
  sink?: DeliveryStateSink;
}

function defaultTimer(cb: () => void, ms: number): { cancel: () => void } {
  const t = setTimeout(cb, ms);
  if (typeof t === "object" && "unref" in t) (t as { unref: () => void }).unref();
  return { cancel: () => clearTimeout(t) };
}

/**
 * Inject a ready (`injecting`) delivery. Returns when the sequence reaches a
 * correlated terminal (`executed`/`failed`), a durable `accepted`, or the
 * bounded lease elapses (`indeterminate`). Never hangs.
 *
 * @param entry a ready row at `injecting` (created/re-armed by the caller).
 */
export async function injectDelivery(entry: OutboxRowView, deps: InjectDeps): Promise<InjectResult> {
  const { pi, store, scan } = deps;
  const now = deps.now ?? (() => 0);
  const setTimer = deps.setTimer ?? defaultTimer;
  const content: DeliveryContent = typeof (entry as { content?: string }).content === "string"
    ? (entry as { content?: string }).content!
    : "";

  const emit = (event: DeliveryStateEvent) => deps.sink?.(event);

  // ── step 2: queued_executing BEFORE the pi call (Bert ordering) ──
  const queued = await store.markQueued({
    delivery_id: entry.delivery_id,
    expected: { expected_revision: entry.revision, expected_attempt: entry.attempt, expected_state: "injecting" },
  });
  if (!queued.ok) {
    // Lost a race / stale — the caller re-reads; not an injection failure.
    emit({ kind: "queue_rejected", delivery_id: entry.delivery_id, reason: queued.reason });
    return { outcome: "indeterminate" };
  }
  let row = queued.entry;
  emit({ kind: "dispatching", delivery_id: entry.delivery_id, attempt: row.attempt });

  const details: ThreadDeliveryDetails = {
    delivery_id: entry.delivery_id,
    thread_id: entry.thread_id,
    attempt: entry.attempt,
    holder_epoch: entry.holder_epoch,
  };

  // ── step 3: INJECT via the executing API (NEVER the bare append) ──
  // Bridge-owned error boundary holding the delivery tuple.
  try {
    await pi.sendMessage(
      { customType: "thread_delivery", content, display: false, details },
      deps.holderIsIdle ? { triggerTurn: true } : { deliverAs: "followUp" },
    );
  } catch (error) {
    // A boundary-catchable synchronous failure → claim → failed (correlated
    // to THIS delivery because we hold the tuple here).
    const failed = await store.markFailed({
      delivery_id: entry.delivery_id,
      expected: { expected_revision: row.revision, expected_attempt: row.attempt, expected_state: "queued_executing" },
    });
    emit({ kind: "injection_failed", delivery_id: entry.delivery_id, error: String(error) });
    return { outcome: "failed", row: failed.ok ? failed.entry : row };
  }

  // ── steps 4-6: await the post-persist seam / executed-signal, bounded ──
  return await new Promise<InjectResult>((resolve) => {
    let settled = false;
    const cleanups: Array<() => void> = [];
    const finish = (result: InjectResult) => {
      if (settled) return;
      settled = true;
      for (const c of cleanups) {
        try { c(); } catch { /* best-effort */ }
      }
      lease.cancel();
      resolve(result);
    };

    const lease = setTimer(() => {
      // Bounded indeterminate lease — never an infinite hold (§C3.1 step 7).
      emit({ kind: "indeterminate", delivery_id: entry.delivery_id, elapsedMs: deps.leaseMs, at: now() });
      finish({ outcome: "indeterminate", entry_id: row.entry_id, row });
    }, deps.leaseMs);

    // Optional E2 correlated-failure fast-path (narrow OPEN dep).
    if (deps.failureAdapter) {
      const un = deps.failureAdapter.onFailure(entry.delivery_id, async (error) => {
        const failed = await store.markFailed({
          delivery_id: entry.delivery_id,
          expected: { expected_revision: row.revision, expected_attempt: row.attempt, expected_state: row.state },
        });
        emit({ kind: "injection_failed", delivery_id: entry.delivery_id, error: String(error) });
        finish({ outcome: "failed", row: failed.ok ? failed.entry : row });
      });
      cleanups.push(un);
    }

    // message_end → SCAN the durable JSONL for details.delivery_id → observed,
    // then accepted if the entry is proven durable.
    const onMessageEnd = async () => {
      const s = scan(entry.delivery_id, entry.attempt, row.entry_id);
      if (!settled && s.entryId && row.state === "queued_executing") {
        const observed = await store.markObserved({
          delivery_id: entry.delivery_id,
          expected: { expected_revision: row.revision, expected_attempt: row.attempt, expected_state: "queued_executing" },
          entry_id: s.entryId,
        });
        if (observed.ok) {
          row = observed.entry;
          emit({ kind: "observed", delivery_id: entry.delivery_id, entry_id: s.entryId });
        }
      }
      if (!settled && s.entryDurable && row.state === "observed") {
        const accepted = await store.markAccepted({
          delivery_id: entry.delivery_id,
          expected: { expected_revision: row.revision, expected_attempt: row.attempt, expected_state: "observed" },
        });
        if (accepted.ok) {
          row = accepted.entry;
          emit({ kind: "accepted", delivery_id: entry.delivery_id, entry_id: row.entry_id });
          // Durable barrier proven — resolve `accepted` (execution is a further
          // signal; the caller/lease governs whether to await it).
          finish({ outcome: "accepted", entry_id: row.entry_id, row });
        }
      }
    };

    // turn_end → corroborate with a persisted assistant CHILD → executed →
    // reconcileAccepted (terminal delivered).
    const onTurnEnd = async () => {
      const s = scan(entry.delivery_id, entry.attempt, row.entry_id);
      if (settled) return;
      if (s.entryDurable && s.evidence.hasPersistedAssistantChild) {
        const rec = await store.reconcileAccepted(
          {
            delivery_id: entry.delivery_id,
            attempt: entry.attempt,
            thread_id: entry.thread_id,
            holder_session_id: entry.holder_session_id,
            entry_id: s.entryId ?? row.entry_id ?? "",
            payload_hash: entry.payload_hash,
            accepted_at: now(),
            executed_at: now(),
          },
          {
            delivery_id: entry.delivery_id,
            attempt: entry.attempt,
            holder_session_id: entry.holder_session_id,
            payload_hash: entry.payload_hash,
          },
        );
        if (rec.action === "terminalize") {
          emit({ kind: "executed", delivery_id: entry.delivery_id, entry_id: s.entryId ?? row.entry_id });
          finish({ outcome: "executed", entry_id: s.entryId ?? row.entry_id, row: rec.entry ?? row });
        } else if (rec.action === "fail_loud") {
          emit({ kind: "fail_loud", delivery_id: entry.delivery_id });
          // Retain — surfaced, never silently delivered; lease still governs.
        }
      }
    };

    const meHandler = () => void onMessageEnd();
    const teHandler = () => void onTurnEnd();
    pi.on("message_end", meHandler);
    pi.on("turn_end", teHandler);
    cleanups.push(() => pi.off?.("message_end", meHandler));
    cleanups.push(() => pi.off?.("turn_end", teHandler));
  });
}
