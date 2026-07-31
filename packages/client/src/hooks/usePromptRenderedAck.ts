import { useEffect } from "react";
import { claimPromptRenderedAck } from "../lib/prompt-rendered-ack.js";

/**
 * A1 render-lifecycle ACK hook (Pete dl-13358 B1). Emits the `prompt_rendered`
 * ACK from the interactive dialog component's ACTUAL mount — a `useEffect`
 * (runs AFTER React commit / DOM mount), keyed by `requestId`, EXACTLY ONCE per
 * promptId (module-level ledger survives remount / reconnect-replay / StrictMode
 * double-invoke).
 *
 * A component that never mounts (renderer fails / hidden branch) never runs this
 * effect → no ACK → the extension records delivered=false. A real mount fires
 * exactly one ACK. Mount it inside the per-prompt dialog card (InteractiveUiCard),
 * NOT a parent container (a parent can commit before the dialog does).
 *
 * @param requestId the promptId of the interactive prompt being rendered
 * @param onRendered callback that sends `prompt_rendered` for this promptId
 */
export function usePromptRenderedAck(
  requestId: string,
  onRendered: ((requestId: string) => void) | undefined,
): void {
  useEffect(() => {
    if (!onRendered) return;
    // claim = true only on the first real mount for this promptId.
    if (claimPromptRenderedAck(requestId)) {
      onRendered(requestId);
    }
  }, [requestId, onRendered]);
}
