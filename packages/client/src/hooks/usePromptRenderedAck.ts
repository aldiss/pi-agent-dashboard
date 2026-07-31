import { useEffect, useRef } from "react";

/**
 * A1 render-lifecycle ACK hook (Pete dl-13358 B1; reliability fix dl-r3 C1).
 * Emits the `prompt_rendered` ACK from the interactive dialog component's ACTUAL
 * mount — a `useEffect` (runs AFTER React commit / DOM mount), keyed by
 * `requestId`.
 *
 * AT-LEAST-ONCE on mount/reconnect (NOT exactly-once-forever). The prior fix
 * used a permanent module-global Set that suppressed the ACK forever after the
 * first claim. If the WS send was dropped / the socket was disconnected at send
 * time, reconnect-replay remounts the visible card but the permanent Set
 * SUPPRESSED the retry → the server receipt stayed `delivered=false` despite an
 * actual render (a false never-delivered). Since `PromptBus.markRendered` is
 * ALREADY idempotent (server-side dedup), client exactly-once is the wrong
 * guarantee.
 *
 * New contract:
 *   - a REAL mount fires the ACK once for THIS mount;
 *   - a remount / reconnect-replay of the card RE-SENDS the ACK (retry) — the
 *     server's idempotent `markRendered` absorbs the duplicate (no false
 *     double-effect: that is the real meaning of "no false duplicate");
 *   - a component that never mounts (renderer fails / hidden branch) never runs
 *     this effect → no ACK → the extension records delivered=false.
 *
 * The only guard is a BOUNDED per-mount ref (cleared on unmount by React
 * discarding the ref) that suppresses a same-mount double-invoke (React
 * StrictMode's development double-effect), never a permanent global.
 *
 * Mount it inside the per-prompt dialog card (InteractiveUiCard), NOT a parent
 * container (a parent can commit before the dialog does).
 *
 * @param requestId the promptId of the interactive prompt being rendered
 * @param onRendered callback that sends `prompt_rendered` for this promptId
 */
export function usePromptRenderedAck(
  requestId: string,
  onRendered: ((requestId: string) => void) | undefined,
): void {
  // Per-MOUNT guard (bounded): the ref is created fresh on each mount and
  // discarded on unmount, so it only dedups a same-mount double-invoke
  // (StrictMode). A genuine remount gets a fresh ref → re-sends (at-least-once).
  const sentThisMount = useRef(false);
  useEffect(() => {
    if (!onRendered) return;
    if (sentThisMount.current) return; // same-mount double-invoke (StrictMode)
    sentThisMount.current = true;
    onRendered(requestId);
  }, [requestId, onRendered]);
}
