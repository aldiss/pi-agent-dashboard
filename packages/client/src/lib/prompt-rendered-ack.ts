/**
 * A1 render-lifecycle ACK — bounded registry of currently-mounted PENDING
 * prompts, for RESEND-ON-RECONNECT (Pete dl-r4 C1-v2).
 *
 * The real defect the round-3 fix missed: `event-reducer.addInteractiveRequest`
 * DEDUPLICATES a replayed same-`requestId` prompt and returns the SAME state, so
 * the existing `InteractiveUiCard` stays MOUNTED across a WS reconnect (NO
 * remount). A mount-scoped guard therefore never re-fires — if the first ACK
 * send dropped (the socket was down; `useWebSocket.send` silently drops when not
 * OPEN), the ACK is never retried → the server receipt stays `delivered=false`
 * forever.
 *
 * Fix: the card REGISTERS its resend callback here while it is mounted-and-
 * pending, and the App-level WS reconnect handler calls `resendAllRenderedAcks`
 * when the socket transitions back to "connected" — RESENDING the ACK for every
 * still-mounted pending prompt. The server's `markRendered` is idempotent, so a
 * resend (or a duplicate) is absorbed with no double-effect.
 *
 * BOUNDED: keyed by promptId; an entry is added on mount and REMOVED on unmount
 * OR on resolve/answer (the card leaves the pending state). Size is bounded by
 * the number of concurrently-visible pending prompts (small); it never grows
 * without bound and never retains a resolved/unmounted prompt.
 */

/** promptId → resend callback for a currently-mounted PENDING prompt. */
const mountedPending = new Map<string, () => void>();

/**
 * Register (or refresh) the resend callback for a mounted-pending promptId.
 * Called from the dialog card's mount effect. Idempotent per id (a re-register
 * just replaces the callback).
 */
export function registerRenderedAck(promptId: string, resend: () => void): void {
  if (!promptId) return;
  mountedPending.set(promptId, resend);
}

/**
 * Remove a promptId from the registry — called on unmount OR on resolve/answer.
 * After removal a reconnect will NOT resend for this id (no resend after
 * resolve; no leak after unmount).
 */
export function unregisterRenderedAck(promptId: string): void {
  mountedPending.delete(promptId);
}

/**
 * Resend the render-ACK for EVERY currently-mounted pending prompt. Called by
 * the App-level WS reconnect handler when the socket transitions to
 * "connected". Server `markRendered` is idempotent → safe to resend/duplicate.
 */
export function resendAllRenderedAcks(): void {
  for (const resend of mountedPending.values()) {
    try {
      resend();
    } catch {
      /* a single resend failure must not block the others */
    }
  }
}

/** Test/diagnostic: current registry size (mounted-pending count). */
export function mountedPendingCount(): number {
  return mountedPending.size;
}

/** Test/diagnostic: is this promptId currently registered? */
export function isRenderedAckRegistered(promptId: string): boolean {
  return mountedPending.has(promptId);
}

/** Test-only: clear the registry between cases. */
export function __resetRenderedAckRegistry(): void {
  mountedPending.clear();
}
