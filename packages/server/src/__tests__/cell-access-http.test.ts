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

  it("classifies session, filtered collection, push-self and safe-public surfaces", () => {
    expect(classifyCellHttpRoute("GET", "/api/sessions")).toEqual({ kind: "session-collection" });
    expect(classifyCellHttpRoute("POST", "/api/session/:id/prompt")).toEqual({ kind: "session", param: "id" });
    expect(classifyCellHttpRoute("GET", "/api/events/:sessionId/:seq")).toEqual({ kind: "session", param: "sessionId" });
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

describe("root HTTP cell preHandler", () => {
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
      isCoreRoute: () => false,
    }));
    // Models later ctx.fastify plugin registrations with early reply hooks,
    // including exact reserved core names while the owning subsystem is absent.
    app.get("/api/plugins/planted/leak", { onRequest: pluginOnRequest }, handler);
    app.get("/auth/login", { onRequest: pluginOnRequest }, handler);
    app.post("/api/health", { onRequest: pluginOnRequest }, handler);
    await app.ready();

    const guestResult = await app.inject({ method: "GET", url: "/api/plugins/planted/leak", headers: { "x-test-user": "guest" } });
    expect(guestResult.statusCode).toBe(403);
    expect(handler).not.toHaveBeenCalled();
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
