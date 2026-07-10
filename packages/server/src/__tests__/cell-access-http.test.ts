import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import type { AuthConfig } from "@blackbelt-technology/pi-dashboard-shared/config.js";
import type { TokenPayload } from "../auth.js";
import { createCellAccessController, createCellRegistrySnapshot } from "../cell-access.js";
import {
  classifyCellHttpActor,
  classifyCellHttpRoute,
  createCellAccessHttpGate,
} from "../cell-access-http.js";
import { registerSessionApi } from "../session-api.js";
import { registerSessionRoutes } from "../routes/session-routes.js";

const OP = { sub: "op@example.com", username: "op", name: "Op", provider: "github", exp: 0 } as TokenPayload;
const GUEST = { sub: "guest@example.com", username: "guest", name: "Guest", provider: "github", exp: 0 } as TokenPayload;
const config: AuthConfig = {
  secret: "test",
  providers: {},
  requireBrowserAuth: true,
  allowedUsers: ["op", "guest"],
  operatorUsers: ["op"],
  guestCellGrants: { guest: ["cell-a"] },
};
const registry = createCellRegistrySnapshot(
  { drivers: {
    A: { real_name: "A", cell: "cell-a", pid: 1 },
    B: { real_name: "B", cell: "cell-b", pid: 2 },
  } },
  [
    { name: "A", sessionId: "a", pid: 1 },
    { name: "B", sessionId: "b", pid: 2 },
  ],
);
const access = createCellAccessController({ authConfig: config, snapshot: registry });
const sessions = new Map<string, DashboardSession>([
  ["a", { id: "a", name: "A", cwd: "/same", source: "tmux", status: "active", startedAt: 1 }],
  ["b", { id: "b", name: "B", cwd: "/same", source: "tmux", status: "active", startedAt: 1 }],
]);
const getSession = (id: string) => sessions.get(id);

function req(opts: {
  route: string;
  method?: string;
  id?: string;
  sessionId?: string;
  principal?: TokenPayload | null;
  actorKind?: "human" | "service" | null;
  ip?: string;
}) {
  return {
    method: opts.method ?? "GET",
    routeOptions: { url: opts.route },
    params: { ...(opts.id ? { id: opts.id } : {}), ...(opts.sessionId ? { sessionId: opts.sessionId } : {}) },
    restPrincipal: opts.principal ?? null,
    restActorKind: opts.actorKind ?? (opts.principal ? "human" : null),
    ip: opts.ip ?? "203.0.113.8",
  } as any;
}

function replyCapture() {
  const state: { code?: number; body?: unknown } = {};
  const reply = {
    code(value: number) { state.code = value; return this; },
    send(value: unknown) { state.body = value; return this; },
  } as any;
  return { state, reply };
}

describe("HTTP cell route/actor classification", () => {
  it("defaults unknown core/plugin APIs to operator-only", () => {
    expect(classifyCellHttpRoute("GET", "/api/plugins/unknown/leak")).toEqual({ kind: "operator-only" });
    expect(classifyCellHttpRoute("GET", "/plugin-leak")).toEqual({ kind: "operator-only" });
    expect(classifyCellHttpRoute("GET", "/auth/plugin-leak")).toEqual({ kind: "operator-only" });
    expect(classifyCellHttpRoute("GET", "/v1/plugin-leak")).toEqual({ kind: "operator-only" });
    expect(classifyCellHttpRoute("POST", "/api/new-core-route")).toEqual({ kind: "operator-only" });
  });

  it("classifies only exact registered session routes as session scope", () => {
    expect(classifyCellHttpRoute("GET", "/api/sessions")).toEqual({ kind: "session-collection" });
    expect(classifyCellHttpRoute("POST", "/api/session/:id/prompt")).toEqual({ kind: "session", param: "id" });
    expect(classifyCellHttpRoute("POST", "/api/session/:id/abort")).toEqual({ kind: "session", param: "id" });
    expect(classifyCellHttpRoute("GET", "/api/events/:sessionId/:seq")).toEqual({ kind: "session", param: "sessionId" });
    expect(classifyCellHttpRoute("GET", "/api/session/:id/planted-plugin-leak")).toEqual({ kind: "operator-only" });
    expect(classifyCellHttpRoute("POST", "/api/session/:id/future-core-route")).toEqual({ kind: "operator-only" });
    expect(classifyCellHttpRoute("POST", "/api/session/:id/shutdown")).toEqual({ kind: "session", param: "id" });
    expect(classifyCellHttpRoute("GET", "/api/session-file")).toEqual({ kind: "operator-only" });
    expect(classifyCellHttpRoute("POST", "/api/push/register")).toEqual({ kind: "push-self" });
    expect(classifyCellHttpRoute("GET", "/api/push/vapid-public-key")).toEqual({ kind: "safe-public" });
    expect(classifyCellHttpRoute("GET", "/api/health")).toEqual({ kind: "health" });
  });

  it("verified human identity wins over loopback; trusted-network omission is anonymous", () => {
    expect(classifyCellHttpActor(req({ route: "/api/health", principal: GUEST, ip: "127.0.0.1" }), access)).toBe("guest");
    expect(classifyCellHttpActor(req({ route: "/api/health", ip: "127.0.0.1" }), access)).toBe("local");
    expect(classifyCellHttpActor(req({ route: "/api/health", actorKind: "service" }), access)).toBe("service");
    expect(classifyCellHttpActor(req({ route: "/api/health", ip: "100.64.0.10" }), access)).toBe("anonymous");
  });
});

describe("derived registered session-route coverage", () => {
  function collect(register: (app: ReturnType<typeof Fastify>) => void) {
    const app = Fastify();
    const routes: Array<{ method: string; url: string }> = [];
    app.addHook("onRoute", (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      for (const method of methods) routes.push({ method: String(method), url: route.url });
    });
    register(app);
    return routes;
  }

  it("only the explicit core-owned inventory derives session reachability", () => {
    const apiDeps: any = {
      sessionManager: { get: () => undefined, update: () => {}, listAll: () => [], unregister: () => {} },
      piGateway: { sendToSession: () => true, isSessionConnected: () => false, address: () => 0 },
      browserGateway: {
        headlessPidRegistry: { register: () => {}, killBySessionId: () => {} },
        broadcastSessionUpdated: () => {}, broadcastSessionRemoved: () => {}, broadcastToAll: () => {},
      },
      requireBrowserAuth: true,
      operatorUsers: ["op@example.com"],
    };
    const routeDeps: any = {
      sessionManager: { listAll: () => [], update: () => {}, get: () => undefined },
      eventStore: { getEvents: () => [], getEvent: () => undefined },
      networkGuard: async () => {},
      hygieneProbes: {},
      broadcastSessionUpdated: () => {},
      requireBrowserAuth: true,
      operatorUsers: ["op@example.com"],
    };
    const routes = [
      ...collect((app) => registerSessionApi(app, apiDeps)),
      ...collect((app) => registerSessionRoutes(app, routeDeps)),
    ];
    const guestCapable = [...new Set(routes
      .filter((route) => {
        const kind = classifyCellHttpRoute(route.method, route.url).kind;
        return kind === "session" || kind === "session-collection";
      })
      .map((route) => `${route.method} ${route.url}`))].sort();
    expect(guestCapable).toEqual([
      "GET /api/events/:sessionId/:seq",
      "GET /api/sessions",
      "POST /api/session/:id/abort",
      "POST /api/session/:id/attach-proposal",
      "POST /api/session/:id/detach-proposal",
      "POST /api/session/:id/flow-control",
      "POST /api/session/:id/hide",
      "POST /api/session/:id/model",
      "POST /api/session/:id/prompt",
      "POST /api/session/:id/rename",
      "POST /api/session/:id/resume",
      "POST /api/session/:id/resurrect",
      "POST /api/session/:id/shutdown",
      "POST /api/session/:id/thinking-level",
      "POST /api/session/:id/unhide",
    ]);

    const accidental = routes
      .filter((route) => route.url.startsWith("/api/session"))
      .filter((route) => !guestCapable.includes(`${route.method} ${route.url}`))
      .filter((route) => classifyCellHttpRoute(route.method, route.url).kind !== "operator-only");
    expect(accidental).toEqual([]);
  });
});

describe("root HTTP cell onRequest", () => {
  const gate = createCellAccessHttpGate({
    cellAccess: access,
    getSession: (id) => sessions.get(id),
  });

  async function verdict(request: any) {
    const capture = replyCapture();
    await gate(request, capture.reply);
    return capture.state;
  }

  it("allows guest inside session; outside and nonexistent are byte-equivalent 404", async () => {
    expect(await verdict(req({ route: "/api/session/:id/prompt", method: "POST", id: "a", principal: GUEST }))).toEqual({});
    const outside = await verdict(req({ route: "/api/session/:id/prompt", method: "POST", id: "b", principal: GUEST }));
    const missing = await verdict(req({ route: "/api/session/:id/prompt", method: "POST", id: "missing", principal: GUEST }));
    expect(outside).toEqual({ code: 404, body: { success: false, error: "session not found" } });
    expect(missing).toEqual(outside);
  });

  it("denies global/CWD and unknown plugin routes to guest but allows operator", async () => {
    for (const request of [
      req({ route: "/api/session-file", principal: GUEST }),
      req({ route: "/api/plugins/planted/leak", principal: GUEST }),
      req({ route: "/api/config", principal: GUEST }),
    ]) {
      expect(await verdict(request)).toEqual({ code: 403, body: { success: false, error: "unauthorized" } });
    }
    expect(await verdict(req({ route: "/api/plugins/planted/leak", principal: OP }))).toEqual({});
  });

  it("does not let a principal-less configured-trusted-network caller reach sessions", async () => {
    expect(await verdict(req({ route: "/api/sessions", ip: "100.64.0.10" }))).toEqual({
      code: 401,
      body: { success: false, error: "authentication required" },
    });
    expect(await verdict(req({ route: "/api/sessions", ip: "127.0.0.1" }))).toEqual({});
  });

  it("allows health/public and push-self to guest while manual push defaults operator-only", async () => {
    expect(await verdict(req({ route: "/api/health", principal: GUEST }))).toEqual({});
    expect(await verdict(req({ route: "/api/push/register", method: "POST", principal: GUEST }))).toEqual({});
    expect(await verdict(req({ route: "/api/push/send", method: "POST", principal: GUEST }))).toEqual({
      code: 403,
      body: { success: false, error: "unauthorized" },
    });
  });

  it("a plugin route and its earlier-lifecycle hook cannot answer before root guest-deny", async () => {
    const app = Fastify({ trustProxy: "loopback" });
    const handler = vi.fn(async () => ({ sessions: ["outside"] }));
    const pluginOnRequest = vi.fn(async (_request: any, reply: any) => reply.send({ leaked: true }));
    app.decorateRequest("restPrincipal", null);
    app.decorateRequest("restActorKind", null);
    app.addHook("onRequest", async (request) => {
      const who = request.headers["x-test-user"];
      if (who === "guest" || who === "op") {
        (request as any).restActorKind = "human";
        (request as any).restPrincipal = who === "guest" ? GUEST : OP;
      }
    });
    app.addHook("onRequest", createCellAccessHttpGate({
      cellAccess: access,
      getSession,
      isCoreRoute: (_method, route) => route === "/api/session/:id/planted-core-leak",
    }));
    // Models later ctx.fastify plugin registrations with early reply hooks,
    // including exact reserved core names while the owning subsystem is absent.
    app.get("/api/plugins/planted/leak", { onRequest: pluginOnRequest }, handler);
    app.get("/api/session/:id/planted-plugin-leak", { onRequest: pluginOnRequest }, handler);
    app.get("/api/session/:id/planted-core-leak", { onRequest: pluginOnRequest }, handler);
    app.post("/api/session/:id/prompt", { onRequest: pluginOnRequest }, handler);
    app.get("/api/sessions", { onRequest: pluginOnRequest }, handler);
    app.post("/api/push/register", { onRequest: pluginOnRequest }, handler);
    app.get("/auth/login", { onRequest: pluginOnRequest }, handler);
    app.post("/api/health", { onRequest: pluginOnRequest }, handler);
    await app.ready();

    const guestResult = await app.inject({ method: "GET", url: "/api/plugins/planted/leak", headers: { "x-test-user": "guest" } });
    expect(guestResult.statusCode).toBe(403);
    expect(handler).not.toHaveBeenCalled();
    expect(pluginOnRequest).not.toHaveBeenCalled();

    const pluginPrefix = await app.inject({ method: "GET", url: "/api/session/a/planted-plugin-leak", headers: { "x-test-user": "guest" } });
    const unknownCorePrefix = await app.inject({ method: "GET", url: "/api/session/a/planted-core-leak", headers: { "x-test-user": "guest" } });
    const spoofedSessionScope = await app.inject({ method: "POST", url: "/api/session/a/prompt", headers: { "x-test-user": "guest" } });
    const spoofedCollectionScope = await app.inject({ method: "GET", url: "/api/sessions", headers: { "x-test-user": "guest" } });
    const spoofedPushScope = await app.inject({ method: "POST", url: "/api/push/register", headers: { "x-test-user": "guest" } });
    expect(pluginPrefix.statusCode).toBe(403);
    expect(unknownCorePrefix.statusCode).toBe(403);
    expect(spoofedSessionScope.statusCode).toBe(403);
    expect(spoofedCollectionScope.statusCode).toBe(403);
    expect(spoofedPushScope.statusCode).toBe(403);
    expect(pluginOnRequest).not.toHaveBeenCalled();

    const reservedAuth = await app.inject({ method: "GET", url: "/auth/login", headers: { "x-test-user": "guest" } });
    expect(reservedAuth.statusCode).toBe(403);
    const postHealth = await app.inject({ method: "POST", url: "/api/health", headers: { "x-forwarded-for": "203.0.113.90" } });
    expect(postHealth.statusCode).toBe(401);
    expect(pluginOnRequest).not.toHaveBeenCalled();

    const opResult = await app.inject({ method: "GET", url: "/api/plugins/planted/leak", headers: { "x-test-user": "op" } });
    expect(opResult.statusCode).toBe(200);
    expect(pluginOnRequest).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled(); // plugin hook intentionally answered operator request
    await app.close();
  });
});
