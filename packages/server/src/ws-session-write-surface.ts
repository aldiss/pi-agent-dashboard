/**
 * The WS session-write SURFACE classification (Build-1b PUSHBACK-1, Fix 1b +
 * FOLD-A + FOLD-D).
 *
 * This is the SINGLE SOURCE OF TRUTH that partitions every browser→server
 * message-type the gateway dispatches into exactly one disposition. It drives
 * TWO consumers that must never diverge:
 *
 *   1. The runtime WS gate (`ws-session-gate.ts`): when the multi-operator flag
 *      is ON, a message-type that is NOT a gated session-write and NOT in an
 *      explicit pass-through / host-deferred allowlist is REFUSED (fail-CLOSED,
 *      default-DENY — FOLD-A). This closes the CLASS, not just the found
 *      instances: a FUTURE `sendToSession` forward added without a registry row
 *      cannot ship ungated — the gate refuses it by construction.
 *
 *   2. The derived-coverage test (`build1b-ws-coverage.test.ts`): it PARSES the
 *      actual `browser-gateway.ts` switch for every `case` whose body reaches
 *      `piGateway.sendToSession` (a session-write forward) and asserts EACH is
 *      classified here — gated (routes through `authorizeSessionAction`) OR
 *      explicitly allowlisted with a rationale. Plant an ungated reachable
 *      session-write handler (a new switch case calling `sendToSession` with no
 *      registry row) → the coverage test goes RED (proves derived-from-the-
 *      surface, not hand-listed).
 *
 * Classification follows EFFECT, fail-CLOSED on effect-uncertainty. The gated
 * set derives operator-only vs co-drive from the ONE `SESSION_WRITE_ACTION_CLASS`
 * (see `session-authz.ts`), so a new operator-only action is auto-gated on BOTH
 * seams.
 */
import { WS_SESSION_WRITE_MESSAGE_ACTION } from "./session-authz.js";

/**
 * The disposition of a browser message-type at the central WS gate.
 *
 * - `gated`        — a session-write that routes through `authorizeSessionAction`
 *   (present in `WS_SESSION_WRITE_MESSAGE_ACTION`). operator-only vs co-drive is
 *   decided by the ONE `SESSION_WRITE_ACTION_CLASS`.
 * - `self-gated`   — a session-write gated INSIDE its own handler
 *   (`send_prompt` → `handleSendPrompt` calls `authorizeSessionAction` directly,
 *   defense-in-depth, already red-arm-tested). Absent from the registry so the
 *   central gate does not double-emit its failure.
 * - `action-gated` — a message-TYPE whose disposition depends on its PAYLOAD
 *   (`ui_management`): the central gate runs an action-aware pre-forward check
 *   (`classifyUiManagement`) that admits a validated READ (co-drive), routes a
 *   validated MUTATION through `authorizeSessionAction` (operator-only), and
 *   REFUSES a forged `(event, action)` for every actor (FIX-P2-1). Not a static
 *   pass-through — see `WS_ACTION_GATED_TYPES`.
 * - `passthrough`  — NOT an operator-level session-write: a keep-alive, a
 *   subscription/preference/view op that never forwards, an allowlisted READ, or
 *   a co-drive INTERACTIVE round-trip (answering a prompt / UI request). Safe for
 *   a bounded co-driver (op-2). Each carries a rationale below.
 * - `host-deferred`— a HOST-surface forward (PTY spawn / worktree removal) that
 *   is PRE-EXISTING-ungated, out of Build-1b's per-session session-write scope,
 *   and SURFACED here as "known-ungated, op-2-live-blocker, deferred-to-Build-1c"
 *   (FOLD-D). Passes the gate in Build-1b (scope-honest, not silently ungated);
 *   op-2-live is HELD until the Build-1c host-surface closure gates it.
 */
export type WsMessageDisposition =
  | "gated"
  | "self-gated"
  | "action-gated"
  | "passthrough"
  | "host-deferred";

/** The gated session-write message-types (keys of the WS registry). */
export const WS_GATED_TYPES: ReadonlySet<string> = new Set(
  Object.keys(WS_SESSION_WRITE_MESSAGE_ACTION),
);

/**
 * ACTION-GATED message-types (Build-1b PUSHBACK-2 FIX-P2-1). A single
 * message-TYPE whose disposition is NOT static: it depends on the message's
 * `action`/`event` payload. The central gate keys on message-TYPE, so a type
 * whose SAFE-vs-operator-only split lives in its BODY needs an action-aware
 * pre-forward check (`classifyUiManagement` in `ws-session-gate.ts`), not a
 * static type-bucket.
 *
 * `ui_management` is the sole member: `browser-gateway.ts` forwards a
 * CALLER-SUPPLIED `{event, action, params}` to the bridge, where
 * `handleUiManagement` does `events.emit(msg.event, data)` — an ARBITRARY
 * extension side-effect keyed on a browser-chosen `event` string (the fire-and-
 * forget `judo:delete-row` shape the doc-comment itself cites). So it CANNOT be
 * a blanket pass-through (the dl-5825 re-review BLOCKER-1). Disposition per
 * message:
 *   - a READ (`action:"list"` on an advertised `view.dataEvent`) → co-drive
 *     pass-through (op-2 allowed);
 *   - a MUTATION (an advertised `rowActions`/`actions` event) → operator-only
 *     (routes through `authorizeSessionAction` → op-2 refused);
 *   - a FORGED `(event, action)` NOT in the session's advertised `uiModules`
 *     descriptor → REFUSED for EVERY actor (a browser-chosen emit that no
 *     extension advertised must never reach the bridge).
 */
export const WS_ACTION_GATED_TYPES: ReadonlySet<string> = new Set(["ui_management"]);

/**
 * Session-writes gated inside their own handler (not the central registry).
 * `send_prompt` calls `authorizeSessionAction` in `handleSendPrompt` (Build 0).
 */
export const WS_SELF_GATED_TYPES: ReadonlySet<string> = new Set(["send_prompt"]);

/**
 * HOST-surface forwards — known-ungated, op-2-live-blocker, deferred-to-Build-1c
 * (FOLD-D). SURFACED-not-silently-ungated.
 *
 * ⚠ Bert coherence-catch (PUSHBACK-1): this set is NOT a trusted hand-list — a
 * hand-list-of-3 is the SAME shape that caused the WS-gap (it could silently
 * miss a 4th host-surface forward). It is the runtime MIRROR of a set DERIVED
 * from the actual route table: the coverage test (`build1b-ws-coverage.test.ts`)
 * computes the host-surface complement =
 *   REACHABLE_FORWARDS − gated − self-gated − read/co-drive-passthrough
 * by PARSING `browser-gateway.ts` + the handler files (a type whose dispatch
 * reaches a HOST sink — `terminalManager.spawn`/`.kill`, `removeWorktree`,
 * `openspecArchiveCompleted` — rather than `piGateway.sendToSession`), and
 * ASSERTS this constant EQUALS that derived set. So:
 *   - a NEW host-surface forward → the derived set grows → the equality test
 *     goes RED until it is added here → it AUTO-appears as known-ungated-
 *     deferred in the coverage artifact (never silently absent);
 *   - a NEW session-write forward left ungated → it reaches `sendToSession`, so
 *     it does NOT land in the host complement → the session-write coverage
 *     assertion goes RED instead (it must be gated or read/co-drive-allowlisted).
 * Close-by-construction for BOTH partitions, same discipline.
 *
 * A host PTY / worktree removal is HOST-scoped (not per-session), pre-existing
 * (ungated before this changeset → NOT a Build-1b regression), and arguably out
 * of Build-1b's session-write scope — but op-2 with a host PTY breaks the
 * bounded-co-driver threat model MORE severely than role_set. Joan's op-2-live
 * contract: a NAMED Build-1c host-surface closure is a HARD op-2-live
 * prerequisite (op-2-live HELD until host-surface closed). Do NOT gate in
 * Build-1b (scope-honest) unless Joan folds Build-1c in.
 */
export const WS_HOST_DEFERRED_TYPES: ReadonlySet<string> = new Set([
  "create_terminal", // → host PTY spawn (arbitrary shell)
  "kill_terminal", // → host PTY kill
  "openspec_bulk_archive", // → worktree removal when cleanupWorktree:true
  // FIX-P2-5 (PUSHBACK-2 m3): host-surface forwards mis-parked as passthrough.
  "openspec_refresh", // → refreshOpenSpec → openspec CLI subprocess (host)
  "pin_directory", // → directoryService.onDirectoryAdded → fs scan + openspec poll (host)
]);

/**
 * Pass-through allowlist: message-types that are NOT operator-level
 * session-writes and are safe for any connected browser (op-2 included) when the
 * flag is ON. Each entry has a one-line rationale (why it is not a gated
 * session-write). This is the "explicitly a read / non-write allowlisted with
 * rationale" arm of Joan's acceptance (a).
 */
export const WS_PASSTHROUGH_TYPES: ReadonlyMap<string, string> = new Map([
  // ── keep-alive / subscription / local server-side state (no forward) ──────
  ["ping", "keep-alive; server replies pong"],
  ["subscribe", "subscription bookkeeping; server-originated reads only"],
  ["unsubscribe", "subscription bookkeeping; local"],
  ["session_view", "viewed-state tracking; local (clears unread)"],
  ["session_unview", "viewed-state tracking; local"],
  ["set_session_translation", "read-only display preference; local browser gate"],
  ["set_push_prefs", "per-session push prefs; local map, no forward"],
  ["reorder_sessions", "session ORDER preference; local, no forward"],
  ["unpin_directory", "directory pin preference; local, no forward"],
  ["reorder_pinned_dirs", "directory order preference; local, no forward"],
  ["rename_terminal", "terminal title; terminalManager only, no session forward"],
  // ── allowlisted READS (forward, but read-only — no operator-level mutation) ─
  ["fetch_content", "READ: fetches session content"],
  ["list_sessions", "READ: lists sessions for a cwd"],
  ["request_commands", "READ: lists available slash-commands"],
  ["request_models", "READ: lists available models"],
  ["request_providers", "READ: lists available providers"],
  ["list_files", "READ: lists files for autocomplete"],
  ["request_installed_packages", "READ: lists installed packages (no handler today)"],
  // ── co-drive INTERACTIVE round-trips (answering a prompt / UI request) ─────
  ["extension_ui_response", "co-drive: answers an extension-UI request (interactive round-trip)"],
  // NOTE: `prompt_response` + `prompt_rendered` are NOT here — Pete dl-13358 B2
  // reclassified them OPERATOR-ONLY (SESSION_WRITE_ACTION_CLASS +
  // WS_SESSION_WRITE_MESSAGE_ACTION). They route through the central gate
  // (authorizeSessionAction), not the co-drive passthrough surface; an
  // operator-only action must not also be pass-allowed.
  ["architect_prompt_response", "legacy no-op (superseded by prompt_response)"],
  // NOTE: `ui_management` is NOT here — it is ACTION-GATED (WS_ACTION_GATED_TYPES,
  // FIX-P2-1). A caller-supplied `event` reaches an arbitrary extension emit, so
  // it cannot be a blanket pass-through; the gate classifies each message
  // (read / mutation / forged) via `classifyUiManagement`.
]);

/**
 * Classify a browser message-type into its gate disposition, or `undefined` when
 * it is UNMAPPED (in none of the four buckets). An unmapped type reaching the
 * gate while the flag is ON is the FOLD-A hazard: the gate fails CLOSED on it.
 */
export function classifyWsMessage(type: string): WsMessageDisposition | undefined {
  if (WS_GATED_TYPES.has(type)) return "gated";
  if (WS_SELF_GATED_TYPES.has(type)) return "self-gated";
  if (WS_ACTION_GATED_TYPES.has(type)) return "action-gated";
  if (WS_HOST_DEFERRED_TYPES.has(type)) return "host-deferred";
  if (WS_PASSTHROUGH_TYPES.has(type)) return "passthrough";
  return undefined;
}

/**
 * True when a message-type is safe to pass the central gate WITHOUT an
 * `authorizeSessionAction` verdict (self-gated, passthrough, or host-deferred).
 * Used by the runtime gate for the flag-ON fail-closed default-deny.
 *
 * `action-gated` is DELIBERATELY excluded: an action-gated type (`ui_management`)
 * is NOT statically pass-allowed — the gate MUST inspect its `action`/`event`
 * payload (`classifyUiManagement`) before deciding read / mutation / forged.
 */
export function isWsPassAllowed(type: string): boolean {
  const disp = classifyWsMessage(type);
  return disp === "self-gated" || disp === "passthrough" || disp === "host-deferred";
}
