/**
 * Shared REST session-write authorization gate (Build 1b — C-REST-CLOSURE).
 *
 * The REST arm of the ONE central `authorizeSessionAction` chokepoint. Both
 * `session-api.ts` (the 14 session-write routes) and `session-routes.ts` (the
 * `POST /api/sessions/retire` route) build their preHandler from THIS factory,
 * so the actor construction + gate call is defined once — no per-route ad-hoc
 * auth, no drift between two hand-written copies (a divergent copy is exactly
 * the class of bug that silently re-opens a seam).
 *
 * The actor is derived ONLY from the REST-captured principal / kind stashed on
 * the request by the auth-plugin `onRequest` hook (`restPrincipal` /
 * `restActorKind`) — NEVER from the request body (anti-spoof, field-by-field).
 */
import type { FastifyRequest, FastifyReply } from "fastify";
import type { ApiResponse } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import type { TokenPayload } from "./auth.js";
import {
  authorizeSessionAction,
  type SessionActor,
  type SessionWriteAction,
} from "./session-authz.js";
import { classifySendPromptAction } from "./send-prompt-authz.js";

/** Frozen-at-startup gate policy, threaded from `requireBrowserAuthAtStartup`. */
export interface RestGatePolicy {
  requireBrowserAuth: boolean;
  operatorUsers?: string[];
}

/**
 * Construct the `SessionActor` from the request's REST-captured identity.
 * `service` when the shared-secret / Bearer path authenticated; otherwise a
 * `human` carrying the verified cookie principal (or null). Never the body.
 */
export function buildActorFromRequest(request: FastifyRequest): SessionActor {
  const kind = (request as any).restActorKind as "human" | "service" | null;
  if (kind === "service") {
    return { kind: "service", id: "rest-shared-secret" };
  }
  const principal = ((request as any).restPrincipal ?? null) as TokenPayload | null;
  return { kind: "human", principal };
}

/**
 * A Fastify preHandler produced by {@link makeRestSessionGate}, tagged with the
 * session-write `action` it gates. The tag (`__sessionWriteAction`) lets a test
 * drive `registerSessionApi`/`registerSessionRoutes` against an `onRoute`-
 * collecting stub and assert EACH session-write route carries a gate whose token
 * matches its effect (FOLD-B derived-from-the-route-table coverage) — instead of
 * comparing the class-map to a hand-literal.
 */
export type SessionWriteGatePreHandler = ((
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<void>) & { readonly __sessionWriteAction: SessionWriteAction };

/**
 * Build a Fastify preHandler that gates a session-write `action` through the
 * central chokepoint. On `{allowed:false}` it replies 401 (no usable identity)
 * / 403 (identified but not permitted, or unknown action) and the route
 * handler never runs. On allow it is a no-op (returns undefined). Flag OFF →
 * `authorizeSessionAction` returns allowed:true unconditionally → no-op.
 *
 * The returned preHandler is tagged with `__sessionWriteAction` (the token) so
 * the FOLD-B route-table coverage test can read the effect off the registered
 * route.
 */
export function makeRestSessionGate(policy: RestGatePolicy) {
  const requireBrowserAuth = policy.requireBrowserAuth === true;
  const operatorUsers = policy.operatorUsers;
  return function gate(action: SessionWriteAction): SessionWriteGatePreHandler {
    const preHandler = async function sessionWriteGate(
      request: FastifyRequest,
      reply: FastifyReply,
    ): Promise<void> {
      const decision = authorizeSessionAction({
        actor: buildActorFromRequest(request),
        action,
        requireBrowserAuth,
        ...(operatorUsers ? { operatorUsers } : {}),
      });
      if (!decision.allowed) {
        const code =
          decision.reason === "no-principal" || decision.reason === "invalid-principal"
            ? 401
            : 403;
        reply.code(code).send({
          success: false,
          error: "unauthorized",
          reason: decision.reason,
        } satisfies ApiResponse & { reason?: string });
      }
    };
    // Tag the preHandler with its action token (read by the FOLD-B coverage test
    // via the onRoute-collecting stub). Non-enumerable so it never serializes.
    Object.defineProperty(preHandler, "__sessionWriteAction", {
      value: action,
      enumerable: false,
    });
    return preHandler as SessionWriteGatePreHandler;
  };
}

/**
 * Build a Fastify preHandler for the `POST /api/session/:id/prompt` route that
 * classifies the request body TEXT before authorizing (Build-1b PUSHBACK-3
 * FIX-P3-1). A command-form text (`!`/`!!` host shell, `/quit`, `/reload`,
 * `/new`, `/model …`, `/compact`, any `/slash`) authorizes as the operator-only
 * `prompt-command` (op-2 → 403); a raw passthrough prompt authorizes as the
 * co-drive `send_prompt` (op-2 allowed, byte-unchanged). This is the REST twin of
 * the WS `handleSendPrompt` command classification — BOTH derive the command
 * split from the SHARED `parseSendPrompt` the bridge executes (no drift).
 *
 * The preHandler is tagged `__sessionWriteAction = "send_prompt"` (the route's
 * PRIMARY effect) so the FOLD-B route-table coverage still sees the /prompt route
 * as a gated `send_prompt` write; the operator-only escalation is an ADDITIONAL
 * per-text tightening on top of the co-drive baseline.
 */
export function makeRestPromptGate(policy: RestGatePolicy): SessionWriteGatePreHandler {
  const requireBrowserAuth = policy.requireBrowserAuth === true;
  const operatorUsers = policy.operatorUsers;
  const preHandler = async function sessionPromptGate(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const text = (request.body as { text?: unknown } | undefined)?.text;
    const action = classifySendPromptAction(text);
    const decision = authorizeSessionAction({
      actor: buildActorFromRequest(request),
      action,
      requireBrowserAuth,
      ...(operatorUsers ? { operatorUsers } : {}),
    });
    if (!decision.allowed) {
      const code =
        decision.reason === "no-principal" || decision.reason === "invalid-principal"
          ? 401
          : 403;
      reply.code(code).send({
        success: false,
        error: "unauthorized",
        reason: decision.reason,
      } satisfies ApiResponse & { reason?: string });
    }
  };
  Object.defineProperty(preHandler, "__sessionWriteAction", {
    value: "send_prompt" as SessionWriteAction,
    enumerable: false,
  });
  return preHandler as SessionWriteGatePreHandler;
}
