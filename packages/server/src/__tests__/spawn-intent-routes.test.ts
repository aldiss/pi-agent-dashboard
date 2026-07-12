/**
 * Deterministic-spawn INTENT routes — HTTP-level tests (design §8 P0, §9 A1):
 *   - flag OFF → both endpoints 404 (zero behavior-change);
 *   - flag ON  → POST mints a token, records the intent, arms the watchdog,
 *                returns { spawnToken }; GET returns { status,… } or 404;
 *   - flavor validation (context-rotation / crash-respawn / new only);
 *   - A1: the route path delivers via the API — it never send-keys a pane
 *     (asserted structurally: no tmux/pane imports in the route module).
 *
 * See change: deterministic-spawn.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { registerSpawnIntentRoutes } from "../routes/spawn-intent-routes.js";
import { createPendingSpawnIntentRegistry, type PendingSpawnIntentRegistry } from "../pending-spawn-intent-registry.js";

const PASSTHRU_GUARD = async () => {};

function makeApp(opts: {
  enabled: boolean;
  registry: PendingSpawnIntentRegistry;
  armed: string[];
  mintToken?: () => string;
}): FastifyInstance {
  const fastify = Fastify({ logger: false });
  registerSpawnIntentRoutes(fastify, {
    pendingSpawnIntent: opts.registry,
    networkGuard: PASSTHRU_GUARD,
    getEnabled: () => opts.enabled,
    armWatchdogOnToken: (token) => { opts.armed.push(token); },
    ...(opts.mintToken ? { mintToken: opts.mintToken } : {}),
  });
  return fastify;
}

describe("spawn-intent routes — flag OFF (404, zero behavior-change)", () => {
  let app: FastifyInstance;
  afterEach(async () => { if (app) await app.close(); });

  it("POST /api/spawn/intent → 404 when disabled", async () => {
    const registry = createPendingSpawnIntentRegistry();
    const armed: string[] = [];
    app = makeApp({ enabled: false, registry, armed });
    const res = await app.inject({
      method: "POST",
      url: "/api/spawn/intent",
      payload: { name: "D", cwd: "/x", flavor: "new", directive: { text: "hi" } },
    });
    expect(res.statusCode).toBe(404);
    // Nothing recorded, nothing armed — the route no-ops entirely.
    expect(registry.size()).toBe(0);
    expect(armed).toHaveLength(0);
  });

  it("GET /api/spawn/intent/:token → 404 when disabled (even if a record exists)", async () => {
    const registry = createPendingSpawnIntentRegistry();
    registry.record({ spawnToken: "tok", name: "D", cwd: "/x", flavor: "new", directive: { text: "hi" } });
    const armed: string[] = [];
    app = makeApp({ enabled: false, registry, armed });
    const res = await app.inject({ method: "GET", url: "/api/spawn/intent/tok" });
    expect(res.statusCode).toBe(404);
  });
});

describe("spawn-intent routes — flag ON", () => {
  let app: FastifyInstance;
  let registry: PendingSpawnIntentRegistry;
  let armed: string[];

  beforeEach(() => {
    registry = createPendingSpawnIntentRegistry();
    armed = [];
  });
  afterEach(async () => { if (app) await app.close(); });

  it("POST records the intent, arms the watchdog, returns { spawnToken }", async () => {
    app = makeApp({ enabled: true, registry, armed, mintToken: () => "TOKEN-1" });
    const res = await app.inject({
      method: "POST",
      url: "/api/spawn/intent",
      payload: { name: "Cartographer-5", cwd: "/orch", flavor: "context-rotation", directive: { text: "replay the ledger" } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ spawnToken: "TOKEN-1" });
    // Recorded + armed on the SAME token.
    expect(registry.get("TOKEN-1")).toMatchObject({ status: "pending", name: "Cartographer-5", flavor: "context-rotation" });
    expect(armed).toEqual(["TOKEN-1"]);
  });

  it("GET returns the intent status view; sessionId appears once resolved", async () => {
    app = makeApp({ enabled: true, registry, armed, mintToken: () => "TOKEN-2" });
    await app.inject({
      method: "POST", url: "/api/spawn/intent",
      payload: { name: "D", cwd: "/orch", flavor: "new", directive: { text: "kickoff" } },
    });

    let res = await app.inject({ method: "GET", url: "/api/spawn/intent/TOKEN-2" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "pending" });

    // Simulate the deliver-on-register resolution.
    registry.resolveOnRegister("TOKEN-2", "sess-xyz");
    res = await app.inject({ method: "GET", url: "/api/spawn/intent/TOKEN-2" });
    expect(res.json()).toEqual({ status: "ok", sessionId: "sess-xyz" });
  });

  it("GET on a failed intent surfaces the reason", async () => {
    app = makeApp({ enabled: true, registry, armed, mintToken: () => "TOKEN-F" });
    await app.inject({
      method: "POST", url: "/api/spawn/intent",
      payload: { name: "D", cwd: "/orch", flavor: "crash-respawn", directive: { text: "wake" } },
    });
    registry.fail("TOKEN-F", "register-timeout");
    const res = await app.inject({ method: "GET", url: "/api/spawn/intent/TOKEN-F" });
    expect(res.json()).toEqual({ status: "failed", reason: "register-timeout" });
  });

  it("GET on an unknown token → 404", async () => {
    app = makeApp({ enabled: true, registry, armed });
    const res = await app.inject({ method: "GET", url: "/api/spawn/intent/never-minted" });
    expect(res.statusCode).toBe(404);
  });

  it("POST rejects an invalid flavor with 400 (never records/arms)", async () => {
    app = makeApp({ enabled: true, registry, armed });
    const res = await app.inject({
      method: "POST", url: "/api/spawn/intent",
      payload: { name: "D", cwd: "/orch", flavor: "resume-exact", directive: { text: "x" } },
    });
    expect(res.statusCode).toBe(400);
    expect(registry.size()).toBe(0);
    expect(armed).toHaveLength(0);
  });

  it("POST rejects a missing directive.text with 400", async () => {
    app = makeApp({ enabled: true, registry, armed });
    const res = await app.inject({
      method: "POST", url: "/api/spawn/intent",
      payload: { name: "D", cwd: "/orch", flavor: "new", directive: {} },
    });
    expect(res.statusCode).toBe(400);
    expect(registry.size()).toBe(0);
  });

  it("POST rejects a missing name/cwd with 400", async () => {
    app = makeApp({ enabled: true, registry, armed });
    const res = await app.inject({
      method: "POST", url: "/api/spawn/intent",
      payload: { flavor: "new", directive: { text: "x" } },
    });
    expect(res.statusCode).toBe(400);
  });

  it("accepts all three legal flavors", async () => {
    for (const flavor of ["new", "context-rotation", "crash-respawn"]) {
      const reg = createPendingSpawnIntentRegistry();
      const arm: string[] = [];
      const a = makeApp({ enabled: true, registry: reg, armed: arm, mintToken: () => `T-${flavor}` });
      const res = await a.inject({
        method: "POST", url: "/api/spawn/intent",
        payload: { name: "D", cwd: "/orch", flavor, directive: { text: "x" } },
      });
      expect(res.statusCode).toBe(200);
      expect(reg.get(`T-${flavor}`)).toMatchObject({ flavor });
      await a.close();
    }
  });
});

describe("spawn-intent routes — A1 (no send-keys / capture-pane on the new path)", () => {
  it("the route module contains ZERO tmux send-keys / capture-pane", () => {
    const routeFile = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../routes/spawn-intent-routes.ts",
    );
    const src = readFileSync(routeFile, "utf-8");
    expect(src).not.toMatch(/send-keys/);
    expect(src).not.toMatch(/capture-pane/);
    // Delivery is via the API primitive (send_prompt), asserted by the wiring
    // test; here we assert the route itself never reaches for a pane.
  });
});
