import { useEffect, useRef } from "react";
import { registerRenderedAck, unregisterRenderedAck } from "../lib/prompt-rendered-ack.js";

/**
 * A1 render-lifecycle ACK hook (Pete dl-13358 B1; reliability fix dl-r4 C1-v2).
 * Emits the `prompt_rendered` ACK from the interactive dialog component's ACTUAL
 * mount, AND registers a RESEND callback so a WS reconnect re-sends the ACK for
 * a still-mounted pending prompt.
 *
 * Why resend-on-reconnect (not mount-scoped only): the real architecture keeps
 * the card MOUNTED across a WS reconnect. `event-reducer.addInteractiveRequest`
 * DEDUPLICATES a replayed same-`requestId` prompt → returns the SAME state → the
 * card never remounts. `useWebSocket.send` silently drops a send while the
 * socket is down. So if the first ACK send dropped, a mount-scoped guard would
 * never retry → `delivered=false` forever. The App-level WS reconnect handler
 * calls `resendAllRenderedAcks()` when the socket returns to "connected",
 * re-sending the ACK for every still-mounted pending prompt. Server
 * `markRendered` is idempotent → resends/duplicates are absorbed (no
 * double-effect).
 *
 * Registry lifecycle (BOUNDED, no leak):
 *   - mount + pending → register the resend callback + send the ACK once;
 *   - unmount → unregister (cleanup);
 *   - resolve/answer (status leaves "pending") → unregister (no resend after
 *     resolve).
 *
 * The mount-scoped `useRef` guards only a same-mount StrictMode double-invoke of
 * the INITIAL send; it is not the reconnect mechanism.
 *
 * Mount it inside the per-prompt dialog card (InteractiveUiCard), NOT a parent
 * container (a parent can commit before the dialog does).
 *
 * @param requestId the promptId of the interactive prompt being rendered
 * @param onRendered callback that sends `prompt_rendered` for this promptId
 * @param status the prompt's lifecycle status; registry entry is dropped when it
 *   leaves "pending" (resolve/answer) so a reconnect never resends a decided prompt
 */
export function usePromptRenderedAck(
  requestId: string,
  onRendered: ((requestId: string) => void) | undefined,
  status?: "pending" | "resolved" | "cancelled" | "dismissed",
): void {
  const sentThisMount = useRef(false);
  const isPending = status === undefined || status === "pending";

  useEffect(() => {
    if (!onRendered) return;
    // Resolved/answered on (re)render: ensure no lingering registry entry — a
    // reconnect must NOT resend a decided prompt.
    if (!isPending) {
      unregisterRenderedAck(requestId);
      return;
    }
    // Register the resend callback so a WS reconnect re-sends this ACK while the
    // card stays mounted-and-pending. Idempotent per id.
    registerRenderedAck(requestId, () => onRendered(requestId));
    // Initial send once per mount (StrictMode double-invoke guarded by the ref).
    if (!sentThisMount.current) {
      sentThisMount.current = true;
      onRendered(requestId);
    }
    // Cleanup on unmount: drop the registry entry (no leak, no post-unmount resend).
    return () => { unregisterRenderedAck(requestId); };
  }, [requestId, onRendered, isPending]);
}
