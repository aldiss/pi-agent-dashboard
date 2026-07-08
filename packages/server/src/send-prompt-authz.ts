/**
 * Single-source `send_prompt` command classification (Build-1b PUSHBACK-3
 * FIX-P3-1), used by BOTH send_prompt seams:
 *   - the WS handler (`handleSendPrompt` in `session-action-handler.ts`), and
 *   - the REST route (`POST /api/session/:id/prompt` in `session-api.ts`, via
 *     `makeRestPromptGate` in `rest-session-gate.ts`).
 *
 * `send_prompt` is co-drive (a bounded co-driver drives the agent by sending
 * prompts). But the server forwards the text UNCHANGED to the bridge, whose
 * `parseSendPrompt` splits it into COMMANDS the bridge EXECUTES — `!`/`!!` →
 * host shell (`pi.exec`), `/quit`/`/exit` → shutdown, `/reload` → kill+respawn,
 * `/new` → spawn, `/model …` → model switch, `/compact` → compact, any `/slash`
 * → command dispatch. So a co-driver could reach the operator-only/host command
 * surface via prompt TEXT.
 *
 * The fix classifies the text with the SHARED `isBridgeCommandText` (derived
 * from the SAME `parseSendPrompt` the bridge executes — no drift by
 * construction) and maps:
 *   - a command-form text → the operator-only `prompt-command` action (op-2
 *     REFUSED);
 *   - a raw passthrough prompt → the co-drive `send_prompt` action (op-2
 *     allowed, as today).
 *
 * BOTH seams call THIS classifier, so the WS guard and the REST gate agree by
 * construction (no second server-side list to drift from the bridge).
 */
import { isBridgeCommandText } from "@blackbelt-technology/pi-dashboard-shared/prompt-command.js";
import type { SessionWriteAction } from "./session-authz.js";

/**
 * Classify a `send_prompt` text into its authorization action: the operator-only
 * `prompt-command` when the text is a bridge COMMAND form, else the co-drive
 * `send_prompt`. Single source of truth for BOTH seams (WS + REST).
 */
export function classifySendPromptAction(text: unknown): SessionWriteAction {
  return typeof text === "string" && isBridgeCommandText(text)
    ? "prompt-command"
    : "send_prompt";
}
