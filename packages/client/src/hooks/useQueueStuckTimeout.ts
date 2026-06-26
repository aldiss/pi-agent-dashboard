import { useEffect, useRef } from "react";

const TIMEOUT_MS = 30_000;

/**
 * Per-entry stuck-timeout for the visible message queue
 * (dashboard-message-queue/v1). Sister to `usePendingPromptTimeout`.
 *
 * An `optimistic` queue entry that the bridge never confirms within the
 * window (e.g. the browser↔server WebSocket was down at send time, so the
 * `send_prompt` never reached the bridge) is flipped to `failed` via
 * `onEntryStuck(queueNonce)` — making the loss VISIBLE ("failed — tap to
 * retry") instead of letting it fall into nowhere. The authoritative
 * `queue_state` snapshot is the confirmation signal; absence within the
 * window = failure.
 *
 * `optimisticEntries` is the list of `{ queueNonce, createdAt }` for entries
 * still in the `optimistic` state. The hook arms one timer per entry keyed by
 * its remaining time-to-deadline and clears them when the entry leaves the
 * optimistic state (confirmed / dispatched / removed).
 */
export function useQueueStuckTimeout(
  optimisticEntries: ReadonlyArray<{ queueNonce: string; createdAt: number }>,
  onEntryStuck: (queueNonce: string) => void,
): void {
  const onStuckRef = useRef(onEntryStuck);
  onStuckRef.current = onEntryStuck;

  // Stable key over the set of pending nonces so the effect re-runs only when
  // the optimistic set actually changes (not on every parent render).
  const key = optimisticEntries.map((e) => e.queueNonce).join("|");

  useEffect(() => {
    if (optimisticEntries.length === 0) return;
    const now = Date.now();
    const timers = optimisticEntries.map((entry) => {
      const remaining = Math.max(0, entry.createdAt + TIMEOUT_MS - now);
      return setTimeout(() => onStuckRef.current(entry.queueNonce), remaining);
    });
    return () => {
      for (const t of timers) clearTimeout(t);
    };
    // `key` captures the identity of the optimistic set; createdAt is stable
    // per nonce so deadlines don't shift across renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
