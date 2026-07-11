/**
 * C3 (bridge side) — the huddle phase holder + the pure fence/hold predicates.
 *
 * The BRIDGE owns the huddle phase enactment: on a `huddle_control{arm}` it goes
 * `active` and FENCES its local-TUI `pi.on("input")` ingress (M-E primary — the
 * one non-server-mediated human-turn path); on `huddle_control{recall}` it goes
 * `idle` and releases the fence. It ACKs each transition back to the server
 * (`huddle_ack`) so the server CAS state machine advances only on real bridge
 * confirmation.
 *
 * This module is the PURE, unit-testable core: a tiny phase holder + the two
 * decision predicates (`shouldFenceTuiInput`, `shouldHoldPromptResponse`). The
 * bridge.ts wiring (pi.on / connection.send) stays thin and calls these — the
 * same discipline as `bridge-context.ts`'s pure helpers (testable without a live
 * pi harness).
 *
 * M-E: `shouldFenceTuiInput` — while the huddle is active, a turn typed into
 * pi's OWN TUI must NOT reach pi (it would bypass the server ledger + pause). The
 * fence buffers/rejects it for the span.
 * M-C: `shouldHoldPromptResponse` — a co-driver's `prompt_response` answering an
 * outstanding ask-user must NOT resume the blocked agent mid-huddle; it is HELD
 * for the span (design M-C default = HOLD).
 */

/** The bridge-local huddle phase. Mirrors the server SM's phase for THIS session. */
export type BridgeHuddlePhase = "idle" | "active";

export interface HuddleBridgeState {
  /** Current bridge-local phase. */
  phase(): BridgeHuddlePhase;
  /** Current huddle epoch (echoed on the ack; 0 when idle/never-armed). */
  epoch(): number;
  /** True when the huddle is active (fence + hold engaged). */
  isActive(): boolean;
  /**
   * Enact an `arm` for `epoch`: go active + engage the fence. Idempotent for the
   * same epoch (a duplicate control message re-affirms). Returns true when the
   * phase became active (so the caller emits the `huddle_ack{active}`).
   */
  arm(epoch: number): boolean;
  /**
   * Enact a `recall` for `epoch`: go idle + release the fence. Returns the turns
   * that were buffered during the span (M-E fence buffer) so the caller can drop
   * or surface them, then clears the buffer. Only acts when `epoch` matches the
   * armed epoch (a stale recall is ignored, returns null).
   */
  recall(epoch: number): TuiBufferedTurn[] | null;
  /** Buffer a fenced local-TUI turn during the span (M-E). */
  bufferTuiTurn(turn: TuiBufferedTurn): void;
  /** Peek the fenced TUI buffer (non-draining). */
  tuiBuffer(): TuiBufferedTurn[];
}

/** A local-TUI turn buffered by the M-E fence during the huddle span. */
export interface TuiBufferedTurn {
  text: string;
  images?: unknown;
  at: number;
}

/**
 * PURE — should the bridge fence (withhold from pi) a local-TUI input turn?
 * True iff the huddle is active. The bridge calls this in its `pi.on("input")`
 * guard; when true it buffers the turn instead of forwarding it to pi (M-E).
 */
export function shouldFenceTuiInput(state: Pick<HuddleBridgeState, "isActive">): boolean {
  return state.isActive();
}

/**
 * PURE — should the bridge HOLD a `prompt_response` (not resume the agent) for
 * the huddle span? True iff the huddle is active (M-C default = HOLD). The bridge
 * calls this before `promptBus.respond`; when true it queues the answer instead
 * of resolving the outstanding ask-user, and applies it after recall.
 */
export function shouldHoldPromptResponse(state: Pick<HuddleBridgeState, "isActive">): boolean {
  return state.isActive();
}

export function createHuddleBridgeState(): HuddleBridgeState {
  let phase: BridgeHuddlePhase = "idle";
  let epoch = 0;
  let buffer: TuiBufferedTurn[] = [];

  return {
    phase: () => phase,
    epoch: () => epoch,
    isActive: () => phase === "active",
    arm(e: number): boolean {
      // Idempotent for the same epoch; a fresh epoch supersedes.
      phase = "active";
      epoch = e;
      return true;
    },
    recall(e: number): TuiBufferedTurn[] | null {
      if (phase !== "active" || e !== epoch) return null;
      phase = "idle";
      const drained = buffer;
      buffer = [];
      return drained;
    },
    bufferTuiTurn(turn: TuiBufferedTurn): void {
      buffer.push(turn);
    },
    tuiBuffer: () => [...buffer],
  };
}
