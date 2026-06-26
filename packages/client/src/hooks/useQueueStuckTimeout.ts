import { useEffect, useRef } from "react";

/**
 * Long-grace backstop for the genuine bridge→pi loss gap (gap iii). NOT the old
 * bare-30s false-fail — see the three-gap model below. ~90s: long enough that a
 * connected-but-slow send confirms first (so it never false-"fails"), short
 * enough that a genuine loss surfaces instead of vanishing.
 */
const LONG_GRACE_MS = 90_000;

/**
 * Delivery-aware stuck-timeout for the visible message queue
 * (dashboard-message-queue/v1 AMEND #5 (f)).
 *
 * The earlier bare-30s timeout was a PROXY for "reached pi" that could not tell
 * "disconnected (never reached pi)" from "connected-but-slow (reached pi, slow
 * confirm)" — so it false-"failed" healthy slow sends and offered a retry that
 * re-sends a message pi already has. `"failed"` is now driven by REAL delivery
 * signals across THREE gaps (Bert dl-2714, own-hand-verified that
 * `piGateway.sendToSession` is fire-and-forget to the bridge WS — `sent===true`
 * means reached-bridge-WS, NOT a pi-enqueue-ack; bridge→pi is a separate un-acked
 * hop), each at its own speed, NONE silent:
 *
 *   (i)  browser↔server WS DROP → FAST-fail. The send didn't reach the server →
 *        retry-safe. (The client can observe its own WS state — `connected`.)
 *   (ii) `send_prompt_failed` event (server's `sent===false`, bridge absent) →
 *        FAST-fail. Handled in `useMessageHandler` (not here) — the server tells
 *        the browser explicitly.
 *   (iii) connected + `sent===true` + NO `message_enqueued` within LONG_GRACE
 *        (~90s) → SLOW-fail. The only true "pi-got-it" signal is
 *        `message_enqueued`; its absence within the long window = a genuine
 *        bridge→pi loss (pi crashed / session ended after `ws.send`) → surface
 *        it (do NOT silent-vanish). A connected-slow send that confirms inside
 *        the window flips to confirmed and is never failed.
 *
 * This hook owns (i) and (iii). It flips a still-`optimistic` entry to `failed`
 * via `onEntryStuck(queueNonce)`. Confirmed/dispatched entries are gone from the
 * optimistic set, so they are never failed.
 *
 * HONEST RESIDUAL (disclosed): the WS can drop AFTER server→pi receipt but
 * BEFORE `message_enqueued` returns. A retry in that narrow window double-sends
 * (pi holds both; the client cannot abort the OLD — deferred control-tail). The
 * idempotency-guard keeps CLIENT STATE correct; the pi-side double is the known
 * bounded residual.
 *
 * @param optimisticEntries `{queueNonce, createdAt}` for entries still optimistic.
 * @param wsConnected whether the browser↔server WebSocket is currently connected.
 * @param onEntryStuck flips the entry to `failed`.
 */
export function useQueueStuckTimeout(
  optimisticEntries: ReadonlyArray<{ queueNonce: string; createdAt: number }>,
  wsConnected: boolean,
  onEntryStuck: (queueNonce: string) => void,
): void {
  const onStuckRef = useRef(onEntryStuck);
  onStuckRef.current = onEntryStuck;

  // Stable key over the pending nonces so the long-grace effect re-arms only
  // when the optimistic set actually changes.
  const key = optimisticEntries.map((e) => e.queueNonce).join("|");

  // Gap (i) — FAST-fail on browser↔server WS drop. If the socket is not
  // connected while optimistic entries exist, those sends did not reach the
  // server → fail them immediately (retry-safe). Fires on the transition into
  // disconnected AND for any entry present while disconnected.
  useEffect(() => {
    if (wsConnected) return;
    if (optimisticEntries.length === 0) return;
    for (const entry of optimisticEntries) {
      onStuckRef.current(entry.queueNonce);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsConnected, key]);

  // Gap (iii) — SLOW-fail long-grace backstop. While CONNECTED, an optimistic
  // entry that never confirms within ~90s is a genuine bridge→pi loss → surface
  // it. Per-entry timer keyed by its remaining time-to-deadline.
  useEffect(() => {
    if (!wsConnected) return; // gap (i) owns the disconnected case
    if (optimisticEntries.length === 0) return;
    const now = Date.now();
    const timers = optimisticEntries.map((entry) => {
      const remaining = Math.max(0, entry.createdAt + LONG_GRACE_MS - now);
      return setTimeout(() => onStuckRef.current(entry.queueNonce), remaining);
    });
    return () => {
      for (const t of timers) clearTimeout(t);
    };
    // `key` captures the optimistic-set identity; createdAt is stable per nonce.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, wsConnected]);
}
