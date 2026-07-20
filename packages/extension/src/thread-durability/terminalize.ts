/**
 * Thread-durability bridge — the persistent terminalization listener (B4
 * step 2; design v3.6 §C3.1 step 6, the "accepted-while-live" completion).
 *
 * WHY: `injectDelivery` resolves at `accepted` (durable barrier proven) and
 * tears down its PER-CALL `turn_end` handler; `recover()` returns `hold` for a
 * LIVE holder with an `accepted` claim (B1 `decideRecovery` never re-delivers
 * while live). So a live-holder delivery that later EXECUTES would sit at
 * `accepted` forever — `delivered` never reflected while the holder lives.
 *
 * FIX: ONE PERSISTENT session-level `pi.on("turn_end", …)` per holder session
 * (not per-injection). On each `turn_end`, for every `accepted`-but-not-
 * `delivered` delivery tracked for that session, run the durable scan
 * (`recover-evidence` `scanEvidence`); when `entryDurable &&
 * hasPersistedAssistantChild` (or a corroborated executed claim) →
 * `store.reconcileAccepted(fact, original)` → `delivered`. A `conflict` →
 * `fail_loud` (retain + surface). Idempotent + lock-safe: the reconcile runs
 * UNDER the B2 per-row lock, and a reconcile on an already-`delivered` row is a
 * `noop` — so a second `turn_end` never double-terminalizes.
 *
 * INERT w.r.t. routing: this only reconciles the outbox state of deliveries
 * the (HELD) drain loop already injected. It routes NO real prompts, resolves
 * NO holder, performs NO reassign.
 */

import type {
  AcceptanceFact,
  DurableScanEvidence,
  InjectableOutboxStore,
  OriginalTuple,
  OutboxEntry,
  ReadableOutboxStore,
} from "@blackbelt-technology/pi-dashboard-shared/thread-durability/index.js";
import type { DeliveryStateSink } from "./delivery-state-channel.js";

/** The minimal pi handle the terminalizer needs — one persistent `turn_end`. */
export interface PiTurnEndHandle {
  on(event: "turn_end", handler: (payload: unknown) => void): void;
  off?(event: "turn_end", handler: (payload: unknown) => void): void;
}

/** The store surface the terminalizer drives: read + reconcile (both lock-safe). */
export type TerminalizeStore = ReadableOutboxStore &
  Pick<InjectableOutboxStore, "reconcileAccepted">;

/** Scan the holder's durable session JSONL for a delivery → evidence. */
export type ScanForDelivery = (entry: OutboxEntry) => DurableScanEvidence;

export interface TerminalizeDeps {
  store: TerminalizeStore;
  /** The durable-session scan (from `recover-evidence` `scanEvidence`). */
  scan: ScanForDelivery;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Optional delivery-state sink (A5). */
  sink?: DeliveryStateSink;
}

/** Build the immutable acceptance fact + original tuple from a durable row. */
function factOf(entry: OutboxEntry, now: number): { fact: AcceptanceFact; original: OriginalTuple } {
  return {
    fact: {
      delivery_id: entry.delivery_id,
      attempt: entry.attempt,
      thread_id: entry.thread_id,
      holder_session_id: entry.holder_session_id,
      entry_id: entry.entry_id ?? "",
      payload_hash: entry.payload_hash,
      accepted_at: entry.updated_at,
      executed_at: now,
    },
    original: {
      delivery_id: entry.delivery_id,
      attempt: entry.attempt,
      holder_session_id: entry.holder_session_id,
      payload_hash: entry.payload_hash,
    },
  };
}

/**
 * A persistent, session-scoped terminalization listener. Register ONE per
 * holder session; `track(entry)` adds an `accepted` delivery to watch; each
 * `turn_end` sweeps the tracked set and terminalizes any that now have durable
 * execution evidence. Deliveries drop out of the set once `delivered` or
 * `fail_loud` (terminal).
 */
export class SessionTerminalizer {
  private readonly deps: TerminalizeDeps;
  private readonly now: () => number;
  /** delivery_id → the accepted row we're watching for this session. */
  private readonly tracked = new Map<string, OutboxEntry>();
  private handler: ((payload: unknown) => void) | null = null;
  private pi: PiTurnEndHandle | null = null;

  constructor(deps: TerminalizeDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => 0);
  }

  /** Register the ONE persistent `turn_end` listener for this session. */
  attach(pi: PiTurnEndHandle): void {
    if (this.handler) return; // already attached — never double-register
    this.pi = pi;
    this.handler = () => void this.onTurnEnd();
    pi.on("turn_end", this.handler);
  }

  /** Stop listening (session end / holder rotation). */
  detach(): void {
    if (this.pi && this.handler) this.pi.off?.("turn_end", this.handler);
    this.handler = null;
    this.pi = null;
  }

  /** Watch an `accepted` delivery for terminalization on the next turn_end. */
  track(entry: OutboxEntry): void {
    if (entry.delivered) return; // already terminal — nothing to watch
    this.tracked.set(entry.delivery_id, entry);
  }

  /** Currently-tracked delivery ids (introspection/tests). */
  trackedIds(): string[] {
    return [...this.tracked.keys()];
  }

  /**
   * The persistent `turn_end` sweep. For each tracked delivery: re-read the
   * durable row; drop terminal rows; scan for durable execution evidence; on
   * `hasPersistedAssistantChild` reconcile → `delivered`; on `conflict`
   * fail-loud (retain). Idempotent — a `noop` reconcile leaves the row intact.
   */
  async onTurnEnd(): Promise<void> {
    for (const deliveryId of [...this.tracked.keys()]) {
      const current = this.deps.store.read(deliveryId);
      if (current === null) {
        this.tracked.delete(deliveryId); // row gone (GC'd) — stop watching
        continue;
      }
      if (current.delivered) {
        this.tracked.delete(deliveryId); // already terminalized — stop watching
        continue;
      }
      if (current.state !== "accepted") {
        // Not yet a durable barrier (still observed/queued) — keep watching,
        // but nothing to reconcile this turn.
        this.tracked.set(deliveryId, current);
        continue;
      }

      const evidence = this.deps.scan(current);
      if (evidence.conflict) {
        // Claim/evidence inconsistency → fail loud (retain, surface). Stop
        // watching — a conflict does not self-heal on a later turn.
        this.deps.sink?.({ kind: "fail_loud", delivery_id: deliveryId });
        this.tracked.delete(deliveryId);
        continue;
      }
      const durableExecution =
        evidence.entryDurable &&
        (evidence.hasPersistedAssistantChild || evidence.executedClaimCorroborated);
      if (!durableExecution) {
        // Live holder mid-turn: entry durable but no assistant child YET →
        // stay `accepted`, no premature terminalize. Keep watching.
        this.tracked.set(deliveryId, current);
        continue;
      }

      const { fact, original } = factOf(current, this.now());
      const res = await this.deps.store.reconcileAccepted(fact, original);
      if (res.action === "terminalize") {
        this.deps.sink?.({ kind: "executed", delivery_id: deliveryId, entry_id: current.entry_id });
        this.tracked.delete(deliveryId);
      } else if (res.action === "fail_loud") {
        this.deps.sink?.({ kind: "fail_loud", delivery_id: deliveryId });
        this.tracked.delete(deliveryId);
      } else {
        // noop (already delivered by a race) — stop watching, never re-write.
        this.tracked.delete(deliveryId);
      }
    }
  }
}
