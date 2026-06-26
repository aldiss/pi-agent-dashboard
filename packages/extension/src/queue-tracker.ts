/**
 * QueueTracker — the bridge's RECONSTRUCTED follow-up queue model.
 *
 * Background (see cc-build-resolution-1.md): pi's extension API
 * (`ExtensionContext` / `ExtensionAPI`) exposes only `hasPendingMessages():
 * boolean` — NOT the `AgentSession` queue accessors (`getFollowUpMessages()`,
 * `pendingMessageCount`, `clearQueue()`). So the bridge cannot READ pi's real
 * queue. Instead it RECONSTRUCTS an accurate model from the signals it CAN
 * observe:
 *   - dashboard-originated enqueue → the bridge's own
 *     `sendUserMessage(deliverAs:"followUp")` call (it knows text + order +
 *     a client-shared `queueNonce` directly). → `enqueueDashboard`.
 *   - TUI-typed enqueue while streaming → the `input` event
 *     (`streamingBehavior:"followUp"`, `source:"interactive"`). The bridge
 *     mints a `queueNonce` (no client card to reconcile). → `enqueueTui`.
 *   - TUI-typed STEER while streaming → the `input` event
 *     (`streamingBehavior:"steer"`). Tracked (no card) → `recordSteer`, so the
 *     dequeue can classify correctly.
 *   - dequeue → work → `message_start(role:"user")`: classify the committing
 *     message by TEXT-MATCH, STEERING-FIRST (mirrors pi `_handleAgentEvent`,
 *     agent-session.js): a matched steer removes-and-dispatches-nothing; else
 *     a text-match against the follow-up FIFO head pops it + stamps its
 *     `queueNonce`; else no pop. → `classifyDequeue`. (A TUI steer ALSO emits
 *     `message_start(user)` but must NOT pop a follow-up card — that was the
 *     blind-`dequeueHead` seam the architects caught.)
 *   - emptiness corroboration → `ctx.hasPendingMessages()`: after each
 *     relevant event, if `false`, hard-resync the model to empty. This bounds
 *     any missed-event drift (e.g. a TUI-side cancel the bridge can't see).
 *     → `clampEmpty`.
 *
 * pi's follow-up queue is FIFO, so the committing follow-up is the head.
 *
 * This is a per-bridge in-memory model (one tracker per bridge process,
 * keyed by nothing — the bridge already scopes to a single active sessionId).
 * NOT persisted. Composes the FIFO vocabulary of
 * `server/src/pending-attach-registry.ts`.
 *
 * See changes: dashboard-message-queue, dashboard-message-queue (AMEND #1
 * steer-vs-followUp classify).
 */

import type {
  MessageEnqueuedEventData,
  QueueStateEventData,
} from "@blackbelt-technology/pi-dashboard-shared/protocol.js";
import type { ImageContent } from "@blackbelt-technology/pi-dashboard-shared/types.js";

/** One entry in the bridge's reconstructed follow-up FIFO. */
export interface QueueEntry {
  queueNonce: string;
  text: string;
  images?: ImageContent[];
  source: "dashboard" | "tui";
}

export class QueueTracker {
  /** The reconstructed follow-up queue, head = next to dispatch. */
  private followUp: QueueEntry[] = [];
  /**
   * Reconstructed steering-message texts (TUI-typed `streamingBehavior:"steer"`
   * while streaming). Steers have NO dashboard card — they are tracked only so
   * the dequeue can classify a committing user message correctly (a steer ALSO
   * emits `message_start(role:user)`, but must NOT pop a follow-up card).
   * Mirrors pi's `_steeringMessages` (agent-session.js). Text-keyed, not FIFO —
   * removal is by text-match, sister to pi's `indexOf`/`splice`.
   */
  private steering: string[] = [];
  private nonceCounter = 0;

  /** Mint a bridge-side queueNonce (used for TUI-origin entries). */
  mintNonce(): string {
    return `q-${++this.nonceCounter}-${Date.now()}`;
  }

  /**
   * Record a dashboard-originated follow-up enqueue. The `queueNonce` is the
   * client-shared id (so the client's optimistic card reconciles by exact
   * match); a fresh one is minted only if the caller passes none (legacy).
   * Returns the `message_enqueued` event data the bridge should forward.
   */
  enqueueDashboard(
    queueNonce: string | undefined,
    text: string,
    images?: ImageContent[],
  ): MessageEnqueuedEventData {
    const nonce = queueNonce ?? this.mintNonce();
    this.followUp.push({ queueNonce: nonce, text, images, source: "dashboard" });
    return {
      queueNonce: nonce,
      text,
      ...(images && images.length > 0 ? { images } : {}),
      source: "dashboard",
    };
  }

  /**
   * Record a TUI-typed follow-up enqueue (from the `input` event). The bridge
   * mints the `queueNonce` — there is no dashboard card to reconcile, so the
   * client appends a fresh confirmed card keyed by this id.
   * Returns the `message_enqueued` event data the bridge should forward.
   */
  enqueueTui(text: string, images?: ImageContent[]): MessageEnqueuedEventData {
    const nonce = this.mintNonce();
    this.followUp.push({ queueNonce: nonce, text, images, source: "tui" });
    return {
      queueNonce: nonce,
      text,
      ...(images && images.length > 0 ? { images } : {}),
      source: "tui",
    };
  }

  /**
   * Record a TUI-typed STEER (`streamingBehavior:"steer"` while streaming).
   * Steers interrupt-after-tool and have NO dashboard card. Tracked only so
   * `classifyDequeue` can mirror pi's steering-first removal and avoid popping
   * an unrelated follow-up card when the steer commits. No event is forwarded.
   */
  recordSteer(text: string): void {
    this.steering.push(text);
  }

  /**
   * Classify a committing user `message_start` by its text, mirroring pi's
   * removal logic (agent-session.js `_handleAgentEvent`): STEERING-FIRST,
   * then follow-up, by TEXT-MATCH — never a blind head-pop.
   *
   *   1. If `text` matches a tracked steer → remove that steer, dispatch
   *      NOTHING (return undefined). A steer is not a queued follow-up card.
   *   2. Else if `text` matches the follow-up FIFO HEAD → pop the head and
   *      return its `queueNonce` (the genuine dispatch→work edge).
   *   3. Else → no pop (return undefined): the committing message is the
   *      turn-initiating message OR an out-of-order / untracked message; popping
   *      would dispatch the WRONG card.
   *
   * Head-only follow-up match (not pi's whole-queue `indexOf`) keeps the FIFO
   * model intact — pi's follow-up queue is FIFO so the committing follow-up IS
   * the head in normal operation; refusing a non-head match is the safe choice
   * (no false dispatch) and the architect-specified faithful fix.
   *
   * Empty `text` (no text blocks) → no pop (return undefined), matching pi's
   * `if (messageText)` guard.
   */
  classifyDequeue(text: string): string | undefined {
    if (text) {
      const steerIdx = this.steering.indexOf(text);
      if (steerIdx !== -1) {
        this.steering.splice(steerIdx, 1);
        return undefined;
      }
      if (this.followUp.length > 0 && this.followUp[0].text === text) {
        const head = this.followUp.shift();
        return head?.queueNonce;
      }
    }
    return undefined;
  }

  /**
   * Corroborate against pi's `hasPendingMessages()` boolean. When pi reports
   * NO pending messages but the model still holds entries (follow-up OR
   * steering), a signal was missed (e.g. TUI-side cancel, or a dequeue without
   * a matching message_start) — hard-resync BOTH queues to empty to bound
   * drift. `hasPendingMessages()` counts steering + follow-up, so a false
   * reading means both are truly empty. Returns true if the model changed.
   */
  clampEmpty(hasPending: boolean): boolean {
    if (!hasPending && (this.followUp.length > 0 || this.steering.length > 0)) {
      this.followUp = [];
      this.steering = [];
      return true;
    }
    return false;
  }

  /** Number of follow-up entries currently modeled. */
  size(): number {
    return this.followUp.length;
  }

  /**
   * Build the `queue_state` snapshot the bridge forwards. `steeringCount` is
   * always 0 in v1 (the bridge cannot enumerate the steering queue — see
   * resolution note); `pendingMessageCount` = followUp length.
   */
  snapshot(source: QueueStateEventData["source"]): QueueStateEventData {
    return {
      // Carry each entry's own origin (AMEND #6 / F5) so the client reconciles
      // origin-aware — a "tui" entry never supersedes a dashboard optimistic.
      followUp: this.followUp.map((e) => ({ queueNonce: e.queueNonce, text: e.text, source: e.source })),
      steeringCount: 0,
      pendingMessageCount: this.followUp.length,
      source,
    };
  }
}
