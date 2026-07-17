import { describe, expect, it } from "vitest";
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import type { AuthConfig } from "@blackbelt-technology/pi-dashboard-shared/config.js";
import type { TokenPayload } from "../auth.js";
import { createCellAccessController, createCellRegistrySnapshot } from "../cell-access.js";
import { createCellAccessHttpGate } from "../cell-access-http.js";
import { createCoreRouteRegistry } from "../core-route-registry.js";

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
const snapshot = createCellRegistrySnapshot(
  { drivers: { A: { real_name: "A", cell: "cell-a", pid: 1 } } },
  [{ name: "A", sessionId: "a", pid: 1 }],
);
const access = createCellAccessController({ authConfig: config, snapshot });
const sessions = new Map<string, DashboardSession>([
  ["a", { id: "a", name: "A", cwd: "/same", source: "tmux", status: "active", startedAt: 1 }],
]);

function req(route: string, principal: TokenPayload, method = "GET") {
  return {
    method,
    routeOptions: { url: route },
    params: {},
    restPrincipal: principal,
    restActorKind: "human",
    ip: "203.0.113.8",
  } as any;
}
function replyCapture() {
  const state: { code?: number; body?: unknown } = {};
  const reply = {
    code(v: number) { state.code = v; return this; },
    send(v: unknown) { state.body = v; return this; },
  } as any;
  return { state, reply };
}

// M4 — a constrained plugin registering the SAME method+path as a core route
// must NOT inherit core ownership by colliding on the forgeable method+path key.
describe("core-route ownership ledger", () => {
  it("marks an uncontested core route as core-owned", () => {
    const reg = createCoreRouteRegistry();
    reg.observe("GET", "/api/health");
    reg.freezeCore();
    expect(reg.isCoreRoute("GET", "/api/health")).toBe(true);
    expect(reg.isCoreRoute("GET", "/api/unknown")).toBe(false);
  });

  it("revokes core ownership when a post-freeze plugin collides on the same method+path", () => {
    const reg = createCoreRouteRegistry();
    reg.observe("GET", "/api/health"); // core owns it
    reg.freezeCore();
    reg.observe("GET", "/api/health"); // plugin collides on the exact key
    expect(reg.isCoreRoute("GET", "/api/health")).toBe(false);
  });
});

describe("HTTP gate honors the ledger for a collided safe-public route", () => {
  async function verdict(gate: any, request: any) {
    const capture = replyCapture();
    await gate(request, capture.reply);
    return capture.state;
  }

  it("denies a guest the collided core health route while operator still passes", async () => {
    const reg = createCoreRouteRegistry();
    reg.observe("GET", "/api/health"); // core registration
    reg.freezeCore();
    reg.observe("GET", "/api/health"); // constrained plugin plants the same path
    const gate = createCellAccessHttpGate({
      cellAccess: access,
      getSession: (id) => sessions.get(id),
      isCoreRoute: (m, r) => reg.isCoreRoute(m, r),
    });
    // Guest must NOT receive the plugin's data at a collided core name.
    expect(await verdict(gate, req("/api/health", GUEST))).toEqual({
      code: 403,
      body: { success: false, error: "unauthorized" },
    });
    // Operator is unaffected.
    expect(await verdict(gate, req("/api/health", OP))).toEqual({});
  });

  it("still lets a guest reach a genuine uncontested core health route", async () => {
    const reg = createCoreRouteRegistry();
    reg.observe("GET", "/api/health");
    reg.freezeCore();
    const gate = createCellAccessHttpGate({
      cellAccess: access,
      getSession: (id) => sessions.get(id),
      isCoreRoute: (m, r) => reg.isCoreRoute(m, r),
    });
    expect(await verdict(gate, req("/api/health", GUEST))).toEqual({});
  });
});
