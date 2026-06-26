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
 *   - dequeue → work → `message_start(role:"user")`: pop the FIFO head and
 *     stamp its `queueNonce` onto the forwarded event. → `dequeueHead`.
 *   - emptiness corroboration → `ctx.hasPendingMessages()`: after each
 *     relevant event, if `false`, hard-resync the model to empty. This bounds
 *     any missed-event drift (e.g. a TUI-side cancel the bridge can't see).
 *     → `clampEmpty`.
 *
 * pi's follow-up queue is FIFO, so head-of-FIFO matches head-of-dequeue.
 *
 * This is a per-bridge in-memory model (one tracker per bridge process,
 * keyed by nothing — the bridge already scopes to a single active sessionId).
 * NOT persisted. Composes the FIFO vocabulary of
 * `server/src/pending-attach-registry.ts`.
 *
 * See change: dashboard-message-queue.
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
   * Pop the head of the FIFO (the message just dispatched into work) and
   * return its `queueNonce` to stamp onto the forwarded `message_start`.
   * Returns undefined when the queue is empty (the user message was the
   * turn-initiating message, degenerate 0-queue case).
   */
  dequeueHead(): string | undefined {
    const head = this.followUp.shift();
    return head?.queueNonce;
  }

  /**
   * Corroborate against pi's `hasPendingMessages()` boolean. When pi reports
   * NO pending messages but the model still holds entries, a signal was
   * missed (e.g. TUI-side cancel, or a dequeue without a matching
   * message_start) — hard-resync the model to empty to bound drift.
   * Returns true if the model changed.
   */
  clampEmpty(hasPending: boolean): boolean {
    if (!hasPending && this.followUp.length > 0) {
      this.followUp = [];
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
      followUp: this.followUp.map((e) => ({ queueNonce: e.queueNonce, text: e.text })),
      steeringCount: 0,
      pendingMessageCount: this.followUp.length,
      source,
    };
  }
}
