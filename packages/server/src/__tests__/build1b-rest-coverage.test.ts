/**
 * Build-1b PUSHBACK-1 — FOLD-B REST route-table DERIVED-coverage.
 *
 * The REST twin of the WS derived-coverage. The OLD `build1b-rest-closure.test.ts`
 * (d) compared the class-map to a hand-literal `EXPECTED_ACTIONS`, never the
 * fastify route table — so a mis-bound token (`gate("abort")` on an operator-only
 * route) type-checks + ships green, and 11-of-12 operator-only routes had NO
 * per-route operator-only test (M3).
 *
 * This suite:
 *   (1) drives `registerSessionApi` + `registerSessionRoutes` against a REAL
 *       fastify instance with an `onRoute` hook that COLLECTS every registered
 *       route + its gate preHandler tag (`__sessionWriteAction`). It asserts
 *       every session-write POST carries a gate whose token MATCHES its effect
 *       (derived from the ROUTE TABLE, not a hand-copy). Red-arm: mis-bind a
 *       route's `gate(...)` token or drop the preHandler → RED.
 *   (2) per-route operator-only enforcement for the 11 untested routes: op-2 →
 *       403 on each (real server). Red-arm: misclassify any as co-drive → RED.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Fastify from "fastify";
import { registerSessionApi } from "../session-api.js";
import { registerSessionRoutes } from "../routes/session-routes.js";
import { loadConfig } from "@blackbelt-technology/pi-dashboard-shared/config.js";
import { signToken, COOKIE_NAME } from "../auth.js";
import { createTestServer, type TestServerHandle } from "../test-support/test-server.js";
import { actionClass, type SessionWriteAction } from "../session-authz.js";

// ── (1) route-table introspection: every session-write POST is gated ─────────
interface CollectedRoute {
  method: string;
  url: string;
  action: SessionWriteAction | undefined;
}

/** Read the `__sessionWriteAction` tag off a route's preHandler(s). */
function gateActionOf(preHandler: unknown): SessionWriteAction | undefined {
  const hs = Array.isArray(preHandler) ? preHandler : preHandler ? [preHandler] : [];
  for (const h of hs) {
    const tag = (h as { __sessionWriteAction?: SessionWriteAction }).__sessionWriteAction;
    if (tag) return tag;
  }
  return undefined;
}

function collectRoutes(register: (app: ReturnType<typeof Fastify>) => void): CollectedRoute[] {
  const app = Fastify();
  const routes: CollectedRoute[] = [];
  app.addHook("onRoute", (r) => {
    // Fastify emits onRoute per HTTP method; ignore auto-added HEAD.
    const methods = Array.isArray(r.method) ? r.method : [r.method];
    for (const m of methods) {
      if (m === "HEAD") continue;
      routes.push({ method: m, url: r.url, action: gateActionOf(r.preHandler) });
    }
  });
  register(app);
  return routes;
}

// The DERIVED expectation: every session-write POST route → its correct effect
// token. This is the ROUTE→effect contract; the test asserts the registered
// gate token EQUALS it (so a mis-bound/absent gate is RED). Not a re-copy of the
// class-map — it maps URLs (the surface) to effects.
const EXPECTED_ROUTE_ACTION: Record<string, SessionWriteAction> = {
  "POST /api/session/:id/prompt": "send_prompt",
  "POST /api/session/:id/abort": "abort",
  "POST /api/session/:id/shutdown": "shutdown",
  "POST /api/session/:id/rename": "rename",
  "POST /api/session/:id/resurrect": "resurrect",
  "POST /api/session/:id/hide": "hide",
  "POST /api/session/:id/unhide": "unhide",
  "POST /api/session/spawn": "spawn",
  "POST /api/session/:id/resume": "resume",
  "POST /api/session/:id/flow-control": "flow-control",
  "POST /api/session/:id/model": "model",
  "POST /api/session/:id/thinking-level": "thinking-level",
  "POST /api/session/:id/attach-proposal": "attach-proposal",
  "POST /api/session/:id/detach-proposal": "detach-proposal",
  "POST /api/sessions/retire": "retire",
};

describe("Build 1b PUSHBACK-1 FOLD-B — REST session-write coverage DERIVES from the route table", () => {
  const deps: any = {
    sessionManager: { get: () => undefined, update: () => {}, listAll: () => [], unregister: () => {} },
    piGateway: { sendToSession: () => true, isSessionConnected: () => false, address: () => 0 },
    browserGateway: {
      headlessPidRegistry: { register: () => {}, killBySessionId: () => {} },
      broadcastSessionUpdated: () => {}, broadcastSessionRemoved: () => {}, broadcastToAll: () => {},
    },
    requireBrowserAuth: true,
    operatorUsers: ["op1@example.com"],
  };
  const routeDeps: any = {
    sessionManager: { listAll: () => [], update: () => {} },
    eventStore: { getEvents: () => [], getEvent: () => undefined },
    networkGuard: async () => {},
    hygieneProbes: {},
    broadcastSessionUpdated: () => {},
    requireBrowserAuth: true,
    operatorUsers: ["op1@example.com"],
  };

  const apiRoutes = collectRoutes((app) => registerSessionApi(app, deps));
  const sessionRoutes = collectRoutes((app) => registerSessionRoutes(app, routeDeps));
  const allRoutes = [...apiRoutes, ...sessionRoutes];

  it("every registered session-write POST carries a gate preHandler tagged with the CORRECT effect token", () => {
    // Red-arm: change a route's `gate("shutdown")` → `gate("abort")` in
    // session-api.ts → the collected token mismatches EXPECTED_ROUTE_ACTION → RED.
    // Red-arm: drop `{ preHandler: gate(...) }` from a route → action undefined → RED.
    for (const [routeKey, expectedAction] of Object.entries(EXPECTED_ROUTE_ACTION)) {
      const [method, url] = routeKey.split(" ");
      const match = allRoutes.find((r) => r.method === method && r.url === url);
      expect(match, `route ${routeKey} must be registered`).toBeDefined();
      expect(
        match!.action,
        `route ${routeKey} must carry a gate preHandler tagged "${expectedAction}"`,
      ).toBe(expectedAction);
    }
  });

  it("no session-write POST route is registered WITHOUT a gate (derived from the table, not a hand-list)", () => {
    // Every POST under /api/session(s) that mutates MUST be in the expected map
    // AND carry a gate. A NEW ungated session-write POST → appears here ungated → RED.
    const KNOWN_UNGATED_POSTS = new Set<string>([]); // none — all session POSTs are writes
    const offenders = allRoutes
      .filter((r) => r.method === "POST")
      .filter((r) => r.url.startsWith("/api/session"))
      .filter((r) => !r.action)
      .filter((r) => !KNOWN_UNGATED_POSTS.has(`${r.method} ${r.url}`))
      .map((r) => `${r.method} ${r.url}`);
    expect(offenders, `ungated session-write POST routes: ${offenders.join(", ")}`).toEqual([]);
  });

  it("each collected gate token is a real enumerated action (no dead/typo token)", () => {
    for (const r of allRoutes) {
      if (!r.action) continue;
      expect(actionClass(r.action), `${r.url} token ${r.action} must be enumerated`).toBeDefined();
    }
  });
});

// ── (2) per-route operator-only enforcement for the 11 untested routes ───────
describe("Build 1b PUSHBACK-1 FOLD-B — per-route operator-only enforcement (op-2 → 403)", () => {
  let testDir: string;
  let configFile: string;
  let origHome: string;
  let handle: TestServerHandle | undefined;
  const SECRET = "b1b-foldb-perroute-secret";

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "b1b-foldb-"));
    fs.mkdirSync(path.join(testDir, ".pi", "dashboard"), { recursive: true });
    configFile = path.join(testDir, ".pi", "dashboard", "config.json");
    origHome = process.env.HOME!;
    process.env.HOME = testDir;
  });
  afterEach(async () => {
    if (handle) { await handle.stop(); handle = undefined; }
    process.env.HOME = origHome;
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  async function boot() {
    fs.writeFileSync(configFile, JSON.stringify({
      auth: { secret: SECRET, requireBrowserAuth: true, operatorUsers: ["op1@example.com"] },
    }));
    const loaded = loadConfig();
    handle = await createTestServer({ authConfig: loaded.auth, resolvedTrustedNetworks: loaded.resolvedTrustedNetworks });
    handle.server.sessionManager.register({ id: "sPR", cwd: "/tmp", source: "tui" as const, startedAt: Date.now() });
    return handle;
  }
  function cookie(sub: string) {
    return `${COOKIE_NAME}=${signToken({ sub, name: "N", username: sub.split("@")[0], provider: "github" }, SECRET)}`;
  }

  // The 11 operator-only routes NOT already covered by a per-route test in
  // build1b-rest-closure.test.ts (which tests shutdown). Each is a session-write
  // that op-2 (a bounded co-driver) must be REFUSED (403 operator-only).
  const ROUTES: Array<{ label: string; url: string; body: unknown }> = [
    { label: "rename", url: "/api/session/sPR/rename", body: { name: "x" } },
    { label: "model", url: "/api/session/sPR/model", body: { provider: "anthropic", modelId: "x" } },
    { label: "thinking-level", url: "/api/session/sPR/thinking-level", body: { level: "high" } },
    { label: "hide", url: "/api/session/sPR/hide", body: {} },
    { label: "unhide", url: "/api/session/sPR/unhide", body: {} },
    { label: "resurrect", url: "/api/session/sPR/resurrect", body: {} },
    { label: "spawn", url: "/api/session/spawn", body: { cwd: "/tmp" } },
    { label: "resume", url: "/api/session/sPR/resume", body: { mode: "continue" } },
    { label: "flow-control", url: "/api/session/sPR/flow-control", body: { action: "toggle_autonomous" } },
    { label: "attach-proposal", url: "/api/session/sPR/attach-proposal", body: { changeName: "c" } },
    { label: "detach-proposal", url: "/api/session/sPR/detach-proposal", body: {} },
  ];

  it("op-2 is REFUSED (403 operator-only) on each of the 11 operator-only routes", async () => {
    // Red-arm: reclassify any of these co-drive in SESSION_WRITE_ACTION_CLASS →
    // op-2 no longer gets 403 on that route → RED. Per-route (not just shutdown).
    const h = await boot();
    for (const r of ROUTES) {
      expect(actionClass(r.label), `${r.label} must be operator-only`).toBe("operator-only");
      const res = await fetch(`http://localhost:${h.httpPort}${r.url}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie("op2@example.com") },
        body: JSON.stringify(r.body),
      });
      expect(res.status, `op-2 ${r.label} must be 403`).toBe(403);
      expect((await res.json()).reason, `op-2 ${r.label} reason`).toBe("operator-only");
    }
  }, 30000);

  it("op-1 (operator) is NOT refused by the gate on the same 11 routes (gate allows; handler may 4xx/5xx on body)", async () => {
    // Control: op-1 passes the gate. We assert NOT 401/403 (the gate verdicts) —
    // the handler may still 400/404/409/500/502 on body/state, which is fine.
    const h = await boot();
    for (const r of ROUTES) {
      const res = await fetch(`http://localhost:${h.httpPort}${r.url}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie("op1@example.com") },
        body: JSON.stringify(r.body),
      });
      expect([401, 403], `op-1 ${r.label} must NOT be gate-refused (got ${res.status})`).not.toContain(res.status);
    }
  }, 30000);
});
