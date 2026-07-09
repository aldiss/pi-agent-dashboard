/**
 * Pure helper for the browser→extension `prompt_response` forward (Surface A).
 *
 * BA-2 anti-spoof COVER: the browser-gateway `prompt_response` case previously
 * forwarded a wholesale `msg as any` spread — a client-forged `author`/identity
 * field could ride through to the extension. This helper reconstructs the
 * forwarded object FIELD-BY-FIELD from the KNOWN functional fields, and stamps
 * the `author` SERVER-SIDE from the connection-bound principal — NEVER from the
 * message body. Delivery is preserved: the functional PromptBus round-trip
 * fields (`promptId`, `answer`, `cancelled`, `source`) survive verbatim so the
 * answer still reaches `PromptBus.respond`.
 *
 * Pure (principal passed in) so it is unit-testable without a WebSocket.
 */
import type { PromptResponseBrowserMessage } from "@blackbelt-technology/pi-dashboard-shared/browser-protocol.js";
import type { PromptResponseServerMessage } from "@blackbelt-technology/pi-dashboard-shared/protocol.js";
import type { TokenPayload } from "./auth.js";
import { deriveAuthor } from "./derive-author.js";

export function buildPromptResponseForward(
  msg: PromptResponseBrowserMessage,
  principal: TokenPayload | null,
): PromptResponseServerMessage {
  const author = deriveAuthor(principal);
  return {
    type: "prompt_response",
    sessionId: msg.sessionId,
    promptId: msg.promptId,
    ...(msg.answer !== undefined ? { answer: msg.answer } : {}),
    ...(msg.cancelled !== undefined ? { cancelled: msg.cancelled } : {}),
    source: msg.source,
    ...(author ? { author } : {}),
  };
}
