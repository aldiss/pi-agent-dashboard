/**
 * Central WS session-write authorization gate (Build-1b WS-closure; hardened in
 * PUSHBACK-1 FOLD-A to fail-CLOSED on an unmapped session-write-shaped type).
 *
 * The WS arm of the ONE `authorizeSessionAction` chokepoint — the sister of
 * `rest-session-gate.ts`. The browser gateway calls `authorizeWsMessage` ONCE,
 * before dispatching any browser message to a handler: if the message-type is a
 * gated session-write (per `WS_SESSION_WRITE_MESSAGE_ACTION`), the actor is
 * built from the connection-bound principal (`ctx.principal`, Build-0's
 * `Map<WS,principal>`) — NEVER the message body (anti-spoof) — and the SAME
 * `authorizeSessionAction` gate the REST + send-seam arms use decides.
 *
 * FOLD-A (the structural root of the WS-gap): the OLD gate returned
 * `{passThrough:true,allowed:true}` for EVERY non-registry type — fail-OPEN,
 * the OPPOSITE polarity to the classified path (unclassified → CLOSED). So a
 * NEW `sendToSession` forward added without a registry row shipped ungated.
 * Now, when the flag is ON, a type that is neither gated nor in the explicit
 * pass-allowed allowlist (`ws-session-write-surface.ts`: self-gated /
 * passthrough / host-deferred) is REFUSED (default-DENY). This closes the CLASS:
 * "add a `sendToSession` handler without classifying it" is impossible-to-ship
 * (the gate refuses it), not merely test-caught. Flag OFF → the gate no-ops
 * (allowed, pass-through) so single-operator behavior is byte-unchanged.
 *
 * Close-by-construction: because the message-type→action registry keys off
 * `SESSION_WRITE_ACTION_CLASS`, a new operator-only action added to that ONE
 * enumeration (+ a registry row) is auto-gated on the WS seam with no per-
 * handler edit. A handler reachable only through this dispatch cannot perform a
 * gated session-write without passing this gate.
 */
import type { BrowserToServerMessage } from "@blackbelt-technology/pi-dashboard-shared/browser-protocol.js";
import type { ExtensionUiModule } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import type { BrowserHandlerContext } from "./browser-handlers/handler-context.js";
import {
  authorizeSessionAction,
  wsMessageAction,
  type AuthorizeSessionActionResult,
} from "./session-authz.js";
import { isWsPassAllowed, WS_ACTION_GATED_TYPES } from "./ws-session-write-surface.js";

export interface WsGateDecision extends AuthorizeSessionActionResult {
  /** The resolved session-write action, when the message-type is gated. */
  action?: string;
  /** True when the message-type is NOT a gated session-write (pass-through). */
  passThrough: boolean;
}

/**
 * The payload disposition of an `ui_management` message (FIX-P2-1). Keyed on the
 * message's `(action, event)` validated against the session's advertised
 * `uiModules` descriptor:
 *   - `read`     — `action:"list"` on an advertised `view.dataEvent` → co-drive
 *     pass-through (op-2 allowed).
 *   - `mutation` — the `event` matches an advertised `rowActions`/`actions`
 *     UiAction → operator-only (routes `ui_management` through the chokepoint).
 *   - `forged`   — an `(event, action)` NOT in the descriptor → REFUSED for
 *     EVERY actor (a browser-chosen emit no extension advertised).
 */
export type UiManagementDisposition = "read" | "mutation" | "forged";

/**
 * Validate an `ui_management` message against the session's advertised
 * `uiModules` descriptor (the SAME descriptor the bridge published via
 * `ui_modules_list`, stored server-side on `session.uiModules`). The `event`
 * string is the load-bearing token: `handleUiManagement` does
 * `events.emit(msg.event, data)`, so an `event` NOT advertised by any module is
 * a forged channel and must be refused REGARDLESS of actor.
 */
export function classifyUiManagement(
  msg: { action?: unknown; event?: unknown },
  modules: ExtensionUiModule[] | undefined,
): UiManagementDisposition {
  const event = typeof msg.event === "string" ? msg.event : "";
  const action = typeof msg.action === "string" ? msg.action : "";
  if (!event) return "forged";
  const mods = modules ?? [];
  // MUTATION FIRST (PUSHBACK-3 FIX-P3-3, defense-in-depth): the `event` is the
  // load-bearing emit token (`handleUiManagement` does `events.emit(msg.event,
  // …)`). If the event appears in ANY advertised `rowActions`/`actions` of ANY
  // view, it is a MUTATION channel — classify it `mutation` EVEN WHEN
  // `action:"list"`. Mutation-membership must WIN over the read/dataEvent check:
  // an ambiguous descriptor where the SAME event is both a table `dataEvent` AND
  // an advertised mutation event must NOT be admitted as a co-drive read (the
  // read-that-mutates hazard). Dormant today (the descriptor is extension-
  // supplied, not browser-poisonable) but correct-by-effect.
  for (const m of mods) {
    const actions = [...(m.view?.rowActions ?? []), ...(m.view?.actions ?? [])];
    for (const a of actions) {
      if (a.event === event) return "mutation";
    }
  }
  // READ: action:"list" on an advertised table/grid data event (and NOT also an
  // advertised mutation event — the mutation scan above already returned).
  if (action === "list") {
    for (const m of mods) {
      if (m.view?.dataEvent === event) return "read";
    }
  }
  // Neither an advertised mutation nor an advertised read → forged.
  return "forged";
}

/**
 * Authorize a browser message through the central chokepoint.
 *
 * For a gated session-write (in `WS_SESSION_WRITE_MESSAGE_ACTION`) it returns the
 * `authorizeSessionAction` verdict + the resolved action.
 *
 * For a NON-gated type: when the flag is OFF it passes through (byte-unchanged).
 * When the flag is ON it passes through ONLY if the type is in the explicit
 * pass-allowed allowlist (self-gated `send_prompt`, a read/subscription/co-drive
 * passthrough, or a host-deferred forward — see `ws-session-write-surface.ts`);
 * an UNMAPPED session-write-shaped type is REFUSED (`unclassified-action`,
 * fail-CLOSED — FOLD-A).
 *
 * The actor is ALWAYS `human{principal}` on the WS path (a browser socket) —
 * there is no `service` WS actor.
 */
export function authorizeWsMessage(
  msg: BrowserToServerMessage,
  ctx: BrowserHandlerContext,
): WsGateDecision {
  const type = (msg as { type?: string }).type ?? "";

  // ── ACTION-GATED types (FIX-P2-1): disposition depends on the PAYLOAD ──────
  // `ui_management` forwards a caller-supplied `event` to an arbitrary extension
  // emit, so it is neither a blanket pass-through nor a static gated type. When
  // the flag is OFF the gate no-ops (byte-unchanged). When ON we classify the
  // message against the session's advertised `uiModules` descriptor:
  //   - forged `(event, action)` → REFUSED for EVERY actor (fail-CLOSED);
  //   - validated READ (action:"list" on a dataEvent) → co-drive pass-through;
  //   - validated MUTATION → operator-only via `authorizeSessionAction`.
  if (WS_ACTION_GATED_TYPES.has(type)) {
    if (!ctx.requireBrowserAuth) {
      return { passThrough: true, allowed: true };
    }
    if (type === "ui_management") {
      const sessionId = (msg as { sessionId?: string }).sessionId ?? "";
      const session = ctx.sessionManager?.get?.(sessionId);
      const disposition = classifyUiManagement(
        msg as { action?: unknown; event?: unknown },
        session?.uiModules,
      );
      if (disposition === "forged") {
        return { passThrough: false, allowed: false, reason: "ui-management-forged" };
      }
      if (disposition === "read") {
        // Stream-2 D (fix-1 MINOR-2): a validated `ui_management` READ
        // (`action:"list"` on an advertised dataEvent) passes through WITHOUT
        // admission by design. N=2 bounds the co-drive WRITE surface (send_prompt
        // + gated writes), NOT reads: a read mutates nothing, and a FORGED
        // payload is already fail-closed above. A non-member 3rd human's READ is
        // therefore intentionally not admission-bound; the corresponding MUTATION
        // (below) DOES thread `operatorSet`+`sessionId` through the chokepoint.
        return { passThrough: true, allowed: true };
      }
      // mutation → operator-only through the ONE chokepoint.
      const decision = authorizeSessionAction({
        actor: { kind: "human", principal: ctx.principal },
        action: "ui_management",
        requireBrowserAuth: ctx.requireBrowserAuth,
        ...(ctx.operatorUsers ? { operatorUsers: ctx.operatorUsers } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(ctx.operatorSet ? { operatorSet: ctx.operatorSet } : {}),
      });
      return { ...decision, action: "ui_management", passThrough: false };
    }
  }

  const action = wsMessageAction(type);
  if (action === undefined) {
    // Not a gated session-write. Flag OFF → pass-through (byte-unchanged). Flag
    // ON → pass-through ONLY when explicitly allowlisted; otherwise fail-CLOSED
    // (default-DENY) so a NEW unmapped session-write-shaped forward cannot ship
    // ungated (FOLD-A).
    if (!ctx.requireBrowserAuth || isWsPassAllowed(type)) {
      return { passThrough: true, allowed: true };
    }
    return { passThrough: false, allowed: false, reason: "unclassified-action" };
  }
  const decision = authorizeSessionAction({
    actor: { kind: "human", principal: ctx.principal },
    action,
    requireBrowserAuth: ctx.requireBrowserAuth,
    ...(ctx.operatorUsers ? { operatorUsers: ctx.operatorUsers } : {}),
    ...(((msg as { sessionId?: string }).sessionId)
      ? { sessionId: (msg as { sessionId?: string }).sessionId }
      : {}),
    ...(ctx.operatorSet ? { operatorSet: ctx.operatorSet } : {}),
  });
  return { ...decision, action, passThrough: false };
}
