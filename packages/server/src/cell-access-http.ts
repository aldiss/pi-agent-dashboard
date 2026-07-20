import type { FastifyReply, FastifyRequest } from "fastify";
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import type { TokenPayload } from "./auth.js";
import { parseAuthCookie, verifyToken } from "./auth.js";
import type { CellAccessController } from "./cell-access.js";
import { isLoopback } from "./localhost-guard.js";

export type CellHttpActor = "operator" | "guest" | "service" | "local" | "anonymous";
export type CellHttpRouteScope =
  | { kind: "safe-public" }
  | { kind: "health" }
  | { kind: "session-collection" }
  | { kind: "session"; param: "id" | "sessionId" }
  | { kind: "push-self" }
  | { kind: "operator-only" }
  | { kind: "service-only" };

function routePath(request: FastifyRequest): string {
  const declared = request.routeOptions?.url;
  if (typeof declared === "string" && declared) return declared;
  return request.url.split("?", 1)[0] || "/";
}

const PUBLIC_AUTH_ROUTES = new Set([
  "GET /auth/login",
  "GET /auth/start/:provider",
  "GET /auth/callback/:provider",
  "POST /auth/logout",
  "GET /auth/status",
  // Native code-exchange: the 256-bit random single-use 60s-TTL code IS the credential
  // (pre-auth by design — this endpoint ISSUES the JWT, so it cannot require auth to reach it).
  // The handler self-guards: single-use burn + expiry-at-take + exact-origin CORS + per-IP
  // rate-limit + no-store (auth-plugin.ts createAuthCodeStore/POST /api/auth/exchange). This
  // mirrors gate #1's op-2 exempt-set (auth-plugin.ts onRequest hook) so the two gates agree;
  // it touches no cell/session, so no cell-access protection is bypassed.
  "POST /api/auth/exchange",
]);
const MODEL_PROXY_ROUTES = new Set([
  "GET /v1/models",
  "POST /v1/chat/completions",
  "POST /v1/messages",
]);

export const GUEST_SESSION_HTTP_ROUTES: ReadonlyMap<string, "id" | "sessionId"> = new Map([
  ["POST /api/session/:id/prompt", "id"],
  ["POST /api/session/:id/abort", "id"],
  ["POST /api/session/:id/shutdown", "id"],
  ["POST /api/session/:id/rename", "id"],
  ["POST /api/session/:id/resurrect", "id"],
  ["POST /api/session/:id/hide", "id"],
  ["POST /api/session/:id/unhide", "id"],
  ["POST /api/session/:id/resume", "id"],
  ["POST /api/session/:id/flow-control", "id"],
  ["POST /api/session/:id/model", "id"],
  ["POST /api/session/:id/thinking-level", "id"],
  ["POST /api/session/:id/attach-proposal", "id"],
  ["POST /api/session/:id/detach-proposal", "id"],
  ["GET /api/events/:sessionId/:seq", "sessionId"],
]);

export function cellHttpRouteKey(method: string, route: string): string {
  return `${method.toUpperCase()} ${route}`;
}

export function classifyCellHttpRoute(method: string, route: string): CellHttpRouteScope {
  const m = method.toUpperCase();
  if (m === "OPTIONS") return { kind: "safe-public" };
  if (route === "/api/health" && (m === "GET" || m === "HEAD")) return { kind: "health" };
  if (route === "/api/push/vapid-public-key" && m === "GET") return { kind: "safe-public" };
  if (route === "/api/sessions" && m === "GET") return { kind: "session-collection" };
  if (route === "/api/session-file" || route === "/api/session-diff") {
    return { kind: "operator-only" };
  }
  const sessionParam = GUEST_SESSION_HTTP_ROUTES.get(cellHttpRouteKey(m, route));
  if (sessionParam) return { kind: "session", param: sessionParam };
  if (
    (route === "/api/push/register" && m === "POST")
    || (route === "/api/push/register/:tokenId" && m === "DELETE")
    || (route === "/api/push/tokens" && m === "GET")
    || (route === "/api/push/test" && m === "POST")
  ) {
    return { kind: "push-self" };
  }
  if (MODEL_PROXY_ROUTES.has(cellHttpRouteKey(m, route))) return { kind: "service-only" };
  // Only known auth/static shell routes are public. A plugin under /auth or /v1
  // never inherits a reserved-prefix bypass.
  if (
    ((route === "/" || route === "/*") && (m === "GET" || m === "HEAD"))
    || PUBLIC_AUTH_ROUTES.has(cellHttpRouteKey(m, route))
  ) {
    return { kind: "safe-public" };
  }
  // Core, plugin, editor, host, cwd and unknown routes default closed for guests.
  return { kind: "operator-only" };
}

export function requestPrincipal(request: FastifyRequest): TokenPayload | null {
  return ((request as any).restPrincipal ?? null) as TokenPayload | null;
}

export function classifyCellHttpActor(
  request: FastifyRequest,
  cellAccess: CellAccessController,
): CellHttpActor {
  const principal = requestPrincipal(request);
  // Verified human identity wins over connection/network location.
  if (principal) return cellAccess.roleForPrincipal(principal);
  if ((request as any).restActorKind === "service") return "service";
  // request.ip is already resolved through Fastify's loopback-only trustProxy.
  if (isLoopback(request.ip)) return "local";
  return "anonymous";
}

export interface CellAccessHttpGateOptions {
  cellAccess: CellAccessController;
  getSession: (id: string) => DashboardSession | undefined;
  getAuthSecret?: () => string | undefined;
  /** Core-route ownership guard for reserved public/service route names. */
  isCoreRoute?: (method: string, route: string) => boolean;
}

function captureBoundaryIdentity(request: FastifyRequest, secret: string | undefined): void {
  if (!secret || requestPrincipal(request)) return;
  const cookie = parseAuthCookie(request.headers.cookie);
  const principal = cookie ? verifyToken(cookie, secret) : null;
  if (principal) {
    (request as any).restPrincipal = principal;
    (request as any).restActorKind = "human";
    return;
  }
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ") && authorization.slice(7) === secret) {
    (request as any).restActorKind = "service";
  }
}

export function createCellAccessHttpGate(options: CellAccessHttpGateOptions) {
  return async function cellAccessHttpGate(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const { cellAccess } = options;
    if (!cellAccess.enabled) return;
    // Root onRequest runs before plugin route hooks and before auth-plugin's own
    // capture hook, so derive the same verified identity directly from headers.
    captureBoundaryIdentity(request, options.getAuthSecret?.());

    const actor = classifyCellHttpActor(request, cellAccess);
    const declaredRoute = request.routeOptions?.url;
    const requestPath = (request.url ?? declaredRoute ?? "/").split("?", 1)[0] || "/";
    // Unmatched GET/HEAD paths are React SPA deep links. Explicit plugin routes
    // still have a declared route and therefore fall through to classification.
    if (
      !declaredRoute
      && (request.method === "GET" || request.method === "HEAD")
      && !requestPath.startsWith("/api/")
      && !requestPath.startsWith("/editor/")
    ) return;

    const declaredPath = routePath(request);
    let scope = classifyCellHttpRoute(request.method, declaredPath);
    if (scope.kind !== "operator-only") {
      const coreOwned = options.isCoreRoute?.(request.method, declaredPath) ?? true;
      if (!coreOwned) {
        scope = { kind: "operator-only" };
      } else if (scope.kind === "safe-public" || scope.kind === "health" || scope.kind === "service-only") {
        return;
      }
    }
    if (actor === "service" || actor === "local") return;

    const principal = requestPrincipal(request);
    if ((actor === "operator" || actor === "guest") && !cellAccess.isPrincipalAdmitted(principal)) {
      reply.code(403).send({ success: false, error: "unauthorized" });
      return;
    }

    if (actor === "anonymous") {
      reply.code(401).send({ success: false, error: "authentication required" });
      return;
    }

    if (actor === "operator") return;
    if (scope.kind === "session-collection" || scope.kind === "push-self") return;

    if (scope.kind === "session") {
      const params = (request.params ?? {}) as Record<string, unknown>;
      const rawId = params[scope.param];
      const sessionId = typeof rawId === "string" ? rawId : "";
      if (sessionId && cellAccess.canViewSession(principal, options.getSession(sessionId))) return;
      reply.code(404).send({ success: false, error: "session not found" });
      return;
    }

    reply.code(403).send({ success: false, error: "unauthorized" });
  };
}
