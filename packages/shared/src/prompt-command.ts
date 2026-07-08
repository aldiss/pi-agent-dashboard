/**
 * Shared prompt-command classification (Build-1b PUSHBACK-3 FIX-P3-1).
 *
 * `parseSendPrompt` is the ONE source of truth for how a `send_prompt` text is
 * split into a bridge COMMAND (`bash`/`compact`/`model`/`shutdown`/`reload`/
 * `new`/`mgmt`/`slash`) vs a RAW passthrough prompt. It lives HERE (shared) so
 * BOTH consumers derive the same partition BY CONSTRUCTION:
 *
 *   1. The bridge (`packages/extension/command-handler.ts`) EXECUTES the parsed
 *      command — `!`/`!!` → host shell (`pi.exec`), `/quit` → shutdown, `/reload`
 *      → reload, `/new` → spawn, `/model` → setModel, `/compact` → compact.
 *   2. The server AUTHORIZES the text BEFORE forwarding it to the bridge
 *      (`session-action-handler.ts` WS seam + `session-api.ts` REST seam): a
 *      command-form text is an operator-only `prompt-command` (op-2 refused); a
 *      raw passthrough stays co-drive (op-2 allowed).
 *
 * The close-by-construction discipline (the same lesson as the WS registry): a
 * hand-maintained server-side command list that drifts from the bridge parser is
 * the next escape. Because the server calls the SAME `parseSendPrompt`, a NEW
 * bridge command form the parser recognizes is AUTO-classified operator-only on
 * the server — there is no second list to keep in sync.
 *
 * Fail-CLOSED on the residual: anything the parser does NOT reduce to
 * `passthrough` (raw natural language) is a command-form and authorized
 * operator-only. `passthrough` is the ONLY co-drive disposition.
 */

/** Parsed result from {@link parseSendPrompt}. */
export type ParsedPrompt =
  | { type: "bash"; command: string; excludeFromContext: boolean }
  | { type: "compact"; customInstructions: string | undefined }
  | { type: "model"; provider: string; modelId: string }
  | { type: "shutdown" }
  | { type: "reload" }
  | { type: "new" }
  | { type: "mgmt"; event: string; data: Record<string, unknown> }
  | { type: "slash"; text: string }
  | { type: "passthrough"; text: string };

/** pi-flows management commands with known event mappings.
 *  These are dispatched via pi.events instead of flow:run.
 *  Flow management commands (flows:new, flows:edit, flows:delete) are
 *  handled in bridge.ts sessionPrompt callback which passes cachedCtx
 *  as fallback context for headless sessions. */
export const MANAGEMENT_COMMAND_EVENTS: Record<string, {
  event: string;
  dataFn: (args: string) => Record<string, unknown>;
}> = {};

/** Parse input text to detect pi internal command prefixes. */
export function parseSendPrompt(text: string): ParsedPrompt {
  // 1. Check !! (must check before !)
  if (text.startsWith("!!")) {
    const command = text.slice(2).trim();
    if (!command) return { type: "passthrough", text };
    return { type: "bash", command, excludeFromContext: true };
  }

  // 2. Check !
  if (text.startsWith("!")) {
    const command = text.slice(1).trim();
    if (!command) return { type: "passthrough", text };
    return { type: "bash", command, excludeFromContext: false };
  }

  // 3. Check /compact
  if (text === "/compact" || text.startsWith("/compact ")) {
    const args = text.startsWith("/compact ") ? text.slice(9).trim() : undefined;
    return { type: "compact", customInstructions: args || undefined };
  }

  // 4. Check /quit and /exit
  if (text === "/quit" || text === "/exit") {
    return { type: "shutdown" };
  }

  // 4b. Check /reload
  if (text === "/reload") {
    return { type: "reload" };
  }

  // 4c. Check /new
  if (text === "/new") {
    return { type: "new" };
  }

  // 4d. Check /model <provider/id>
  if (text.startsWith("/model ")) {
    const modelStr = text.slice(7).trim();
    const slashIdx = modelStr.indexOf("/");
    if (slashIdx > 0) {
      return { type: "model", provider: modelStr.slice(0, slashIdx), modelId: modelStr.slice(slashIdx + 1) };
    }
  }

  // 5. Check management commands (/flows:new, etc.) with known event mappings
  if (text.startsWith("/") && !text.includes("\n")) {
    const cmdText = text.slice(1);
    const spaceIdx = cmdText.indexOf(" ");
    const cmdName = spaceIdx === -1 ? cmdText : cmdText.slice(0, spaceIdx);
    const cmdArgs = spaceIdx === -1 ? "" : cmdText.slice(spaceIdx + 1);
    const mgmt = MANAGEMENT_COMMAND_EVENTS[cmdName];
    if (mgmt) {
      return { type: "mgmt", event: mgmt.event, data: mgmt.dataFn(cmdArgs) };
    }
  }

  // 6. Check / prefix (generic slash command)
  if (text.startsWith("/") && !text.includes("\n")) {
    return { type: "slash", text };
  }

  // 5. Passthrough
  return { type: "passthrough", text };
}

/**
 * True when a `send_prompt` text is a bridge COMMAND form (NOT a raw passthrough
 * prompt). The server routes a command-form text through the operator-only
 * `prompt-command` authorization (op-2 refused); a raw passthrough stays
 * co-drive.
 *
 * Derived DIRECTLY from {@link parseSendPrompt} (the ONE source of truth the
 * bridge executes against) — `passthrough` is the sole co-drive disposition, so
 * every other parse result (a command the bridge would EXECUTE) is a command
 * form. A new command form recognized by the parser is auto-covered here.
 *
 * NOTE the boundary matches the bridge exactly: an EMPTY `!`/`!!` is
 * `passthrough` (the bridge sends it as a plain message), a multi-line `/…`
 * text is `passthrough` (the bridge expands it as a prompt template, not a
 * command), and both stay co-drive — as they are on the bridge.
 */
export function isBridgeCommandText(text: string): boolean {
  return parseSendPrompt(text).type !== "passthrough";
}
