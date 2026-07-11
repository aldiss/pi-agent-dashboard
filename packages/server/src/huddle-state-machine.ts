/**
 * C3 — the serialized, bridge-ACKed huddle pause state machine (+ durable outbox).
 *
 * ONE state machine per session. Phases (design C3):
 *   idle → arming → active → recalling → idle
 * Transitions are SERIALIZED (compare-and-set): a transition is legal only from
 * its exact predecessor phase, so two concurrent `huddle-start`s or a recall
 * racing an arm cannot interleave — the second attempt is refused, not queued
 * ambiguously. The SERVER proposes a transition (arming / recalling) and the
 * BRIDGE ACKs the phase it reached (active / idle) — the server advances the SM
 * ONLY on that ack (`ackActive` / `ackIdle`), never optimistically, because the
 * bridge owns the load-bearing side effect (fencing its local-TUI input, M-E).
 *
 * EPOCH: a monotonic counter bumped on each `requestArm`. It rides the
 * control/ack carriers so a STALE ack (from a prior span, e.g. a bridge that
 * reconnected across a fast recall→restart) is DROPPED — `ackActive`/`ackIdle`
 * ignore an ack whose epoch ≠ the current epoch. This is what makes the CAS
 * safe across a bridge reload (composes with the M-F reservation).
 *
 * DURABLE OUTBOX: while a huddle is non-idle, real agent-bound prompts that
 * would otherwise be delivered mid-huddle (the M-B ended-replay resume-prompt)
 * are HELD here keyed by epoch, and drained after recall to idle. This is the
 * AGENT-DELIVERY hold for EXECUTABLE prompts — distinct from the C1 ledger's
 * agent-hold (which holds the huddle EXCHANGE as quoted transcript DATA for the
 * C4 catch-up). A resume-prompt is a real turn the agent must EXECUTE after
 * recall (preserving its record-time author), never quoted transcript — so it
 * cannot ride the C4 frame; it rides this outbox. "Durable" = survives the huddle
 * SPAN (a bridge reload mid-span does not lose it); in-memory, per-run.
 */
import type { HuddlePhase } from "@blackbelt-technology/pi-dashboard-shared/huddle.js";
import type { MessageAuthor, ImageContent } from "@blackbelt-technology/pi-dashboard-shared/types.js";

/** An executable prompt held for post-recall delivery (M-B resume-prompt). */
export interface HeldOutboxPrompt {
  text: string;
  images?: ImageContent[];
  /** Record-time author (server-derived; preserved across the hold). */
  author?: MessageAuthor;
  /** Provenance tag for diagnostics (which mid-huddle path deposited it). */
  source: "resume-replay";
  /** The old sessionId the resume targeted (for the delivery to re-key). */
  oldSessionId?: string;
  /** The session file to resume from (M-B carries it on the registry entry). */
  sessionFile?: string;
}

export type HuddleTransitionResult =
  | { ok: true; epoch: number; phase: HuddlePhase }
  | { ok: false; reason: "wrong-phase"; phase: HuddlePhase };

export interface HuddleStateMachine {
  /** Current phase for a session (idle when never started / fully recalled). */
  phaseOf(sessionId: string): HuddlePhase;
  /** Current huddle epoch for a session (0 before the first arm). */
  epochOf(sessionId: string): number;
  /** True when the session's phase is non-idle (arming/active/recalling). */
  isHuddling(sessionId: string): boolean;
  /**
   * Operator requested `huddle-start`. CAS idle→arming; bumps the epoch. Returns
   * the new epoch + phase to send on the `huddle_control{arm}` carrier, or
   * `wrong-phase` when not idle (a huddle is already in flight — refused, not queued).
   */
  requestArm(sessionId: string): HuddleTransitionResult;
  /**
   * Bridge ACKed `phase:"active"` for `epoch`. CAS arming→active, ONLY when the
   * ack epoch matches the current epoch (a stale ack is dropped). Returns the
   * transition result; `wrong-phase` if not arming or the epoch is stale.
   */
  ackActive(sessionId: string, epoch: number): HuddleTransitionResult;
  /**
   * Operator requested `huddle-recall`. CAS active→recalling (epoch unchanged).
   * Returns the epoch to send on the `huddle_control{recall}` carrier, or
   * `wrong-phase` when not active.
   */
  requestRecall(sessionId: string): HuddleTransitionResult;
  /**
   * Bridge ACKed `phase:"idle"` for `epoch`. CAS recalling→idle, ONLY on an
   * epoch match. The huddle span is over; the caller then drains the C1 ledger
   * (C4 catch-up) + this outbox. Returns the result; `wrong-phase` if not
   * recalling or the epoch is stale.
   */
  ackIdle(sessionId: string, epoch: number): HuddleTransitionResult;
  /** Hold an executable agent-bound prompt for the current span (M-B). */
  holdOutbox(sessionId: string, prompt: HeldOutboxPrompt): void;
  /** Peek the held outbox for a session's current epoch (non-draining). */
  outboxOf(sessionId: string): HeldOutboxPrompt[];
  /** Drain + return the held outbox (called after recall→idle). */
  drainOutbox(sessionId: string): HeldOutboxPrompt[];
  /** Drop all state for a session (session end — leak guard). */
  clearSession(sessionId: string): void;
}

interface SessionState {
  phase: HuddlePhase;
  epoch: number;
  outbox: HeldOutboxPrompt[];
}

function initialState(): SessionState {
  return { phase: "idle", epoch: 0, outbox: [] };
}

export function createHuddleStateMachine(): HuddleStateMachine {
  const states = new Map<string, SessionState>();

  function stateOf(sessionId: string): SessionState {
    let s = states.get(sessionId);
    if (!s) {
      s = initialState();
      states.set(sessionId, s);
    }
    return s;
  }

  function phaseOf(sessionId: string): HuddlePhase {
    return states.get(sessionId)?.phase ?? "idle";
  }

  function epochOf(sessionId: string): number {
    return states.get(sessionId)?.epoch ?? 0;
  }

  function isHuddling(sessionId: string): boolean {
    return phaseOf(sessionId) !== "idle";
  }

  function requestArm(sessionId: string): HuddleTransitionResult {
    const s = stateOf(sessionId);
    if (s.phase !== "idle") {
      return { ok: false, reason: "wrong-phase", phase: s.phase };
    }
    s.epoch += 1; // fresh span — bump the epoch so stale acks are dropped
    s.phase = "arming";
    return { ok: true, epoch: s.epoch, phase: s.phase };
  }

  function ackActive(sessionId: string, epoch: number): HuddleTransitionResult {
    const s = stateOf(sessionId);
    if (s.phase !== "arming" || epoch !== s.epoch) {
      return { ok: false, reason: "wrong-phase", phase: s.phase };
    }
    s.phase = "active";
    return { ok: true, epoch: s.epoch, phase: s.phase };
  }

  function requestRecall(sessionId: string): HuddleTransitionResult {
    const s = stateOf(sessionId);
    if (s.phase !== "active") {
      return { ok: false, reason: "wrong-phase", phase: s.phase };
    }
    s.phase = "recalling";
    return { ok: true, epoch: s.epoch, phase: s.phase };
  }

  function ackIdle(sessionId: string, epoch: number): HuddleTransitionResult {
    const s = stateOf(sessionId);
    if (s.phase !== "recalling" || epoch !== s.epoch) {
      return { ok: false, reason: "wrong-phase", phase: s.phase };
    }
    s.phase = "idle";
    return { ok: true, epoch: s.epoch, phase: s.phase };
  }

  function holdOutbox(sessionId: string, prompt: HeldOutboxPrompt): void {
    stateOf(sessionId).outbox.push(prompt);
  }

  function outboxOf(sessionId: string): HeldOutboxPrompt[] {
    return [...(states.get(sessionId)?.outbox ?? [])];
  }

  function drainOutbox(sessionId: string): HeldOutboxPrompt[] {
    const s = states.get(sessionId);
    if (!s) return [];
    const held = s.outbox;
    s.outbox = [];
    return held;
  }

  function clearSession(sessionId: string): void {
    states.delete(sessionId);
  }

  return {
    phaseOf,
    epochOf,
    isHuddling,
    requestArm,
    ackActive,
    requestRecall,
    ackIdle,
    holdOutbox,
    outboxOf,
    drainOutbox,
    clearSession,
  };
}
