import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import jwt from "jsonwebtoken";
import { WebSocket } from "ws";
import { discoverPlugins } from "@blackbelt-technology/dashboard-plugin-runtime/server";
import type { AuthConfig } from "@blackbelt-technology/pi-dashboard-shared/config.js";
import { signToken, COOKIE_NAME } from "../auth.js";
import { createTestServer, type TestServerHandle, type TestServerOverrides } from "../test-support/test-server.js";

const fixture = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const originalHome = process.env.HOME;
  if (!originalHome || originalHome === os.userInfo().homedir) throw new Error("Isolated test HOME required");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-boundary-e2e-"));
  process.env.HOME = home;
  fs.mkdirSync(path.join(home, ".pi", "agent", "sessions"), { recursive: true });
  fs.mkdirSync(path.join(home, ".pi", "dashboard"), { recursive: true });
  return {
    home,
    originalHome,
    spawn: vi.fn(),
    preflight: vi.fn(),
    attachQueues: [] as Array<{ enqueue: ReturnType<typeof vi.fn>; size: (cwd: string) => number }>,
    bootstrapQueues: [] as Array<{ enqueue: ReturnType<typeof vi.fn>; size: () => number }>,
  };
});

vi.mock("../process-manager.js", async (original) => ({
  ...await original<typeof import("../process-manager.js")>(),
  spawnPiSession: fixture.spawn,
}));
vi.mock("../spawn-preflight.js", async (original) => ({
  ...await original<typeof import("../spawn-preflight.js")>(),
  preflightSpawn: fixture.preflight,
}));
vi.mock("../pending-attach-registry.js", async (original) => {
  const actual = await original<typeof import("../pending-attach-registry.js")>();
  return {
    ...actual,
    createPendingAttachRegistry: (...args: Parameters<typeof actual.createPendingAttachRegistry>) => {
      const queue = actual.createPendingAttachRegistry(...args);
      const enqueue = vi.spyOn(queue, "enqueue");
      fixture.attachQueues.push({ enqueue, size: queue.size });
      return queue;
    },
  };
});
vi.mock("../bootstrap-queue.js", async (original) => {
  const actual = await original<typeof import("../bootstrap-queue.js")>();
  return {
    ...actual,
    createBootstrapQueue: (...args: Parameters<typeof actual.createBootstrapQueue>) => {
      const queue = actual.createBootstrapQueue(...args);
      const enqueue = vi.spyOn(queue, "enqueue");
      fixture.bootstrapQueues.push({ enqueue, size: queue.size });
      return queue;
    },
  };
});

const SECRET = "spawn-boundary-test-signing-key";
const BRIDGE_TOKEN = "a".repeat(64);
let handle: TestServerHandle | undefined;
let sequence = 0;
const sockets: WebSocket[] = [];

beforeEach(() => {
  fixture.spawn.mockReset().mockResolvedValue({ success: true, message: "fixture spawn", dashboardSpawned: true });
  fixture.preflight.mockReset().mockReturnValue({ ok: true, reasons: [] });
  fixture.attachQueues.length = 0;
  fixture.bootstrapQueues.length = 0;
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  if (handle) await handle.stop();
  handle = undefined;
});

afterAll(() => {
  process.env.HOME = fixture.originalHome;
  fs.rmSync(fixture.home, { recursive: true, force: true });
});

function token(username = "op", secret = SECRET) {
  return signToken({ sub: `${username}@example.com`, username, name: username, provider: "github" }, secret);
}

async function start(requireBrowserAuth: boolean, localBridgeOperator: string | null = "op", overrides: TestServerOverrides = {}) {
  const cwd = path.join(fixture.home, `project-${++sequence}`);
  const outside = path.join(fixture.home, `outside-${sequence}`);
  fs.mkdirSync(cwd);
  fs.mkdirSync(outside);
  const authConfig: AuthConfig = {
    secret: SECRET,
    providers: { github: { clientId: "test-client", clientSecret: "test-secret" } },
    allowedUsers: ["op", "guest"],
    operatorUsers: ["op"],
    requireBrowserAuth,
    localBridgeOperator,
  };
  const dashboardDir = path.join(fixture.home, ".pi", "dashboard");
  fs.writeFileSync(path.join(dashboardDir, "config.json"), JSON.stringify({
    auth: authConfig, spawnStrategy: "headless", piHost: overrides.piHost ?? "127.0.0.1", bridge: { requireToken: false },
    plugins: Object.fromEntries(discoverPlugins().map(({ manifest }) => [manifest.id, { enabled: false }])),
  }));
  fs.writeFileSync(path.join(dashboardDir, "preferences.json"), JSON.stringify({ pinnedDirectories: [cwd], sessionOrder: {} }));
  fs.writeFileSync(path.join(dashboardDir, "bridge-token"), `${BRIDGE_TOKEN}\n`, { mode: 0o600 });
  handle = await createTestServer({ authConfig, pingInterval: 0, resurrectionSweepMs: 0, resolvedTrustedNetworks: ["100.64.0.0/10"], ...overrides });
  return { cwd, outside, base: `http://127.0.0.1:${handle.httpPort}` };
}

function post(base: string, route: string, body: unknown, credential?: string, headers: Record<string, string> = {}) {
  return fetch(`${base}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(credential ? { Cookie: `${COOKIE_NAME}=${credential}` } : {}), ...headers },
    body: JSON.stringify(body),
  });
}

interface SocketProbe {
  ws: WebSocket;
  messages: any[];
  status: number;
}

async function openSocket(url: string, headers: Record<string, string> = {}, protocols: string[] = []): Promise<SocketProbe> {
  const ws = new WebSocket(url, protocols, { headers });
  sockets.push(ws);
  const messages: any[] = [];
  ws.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
  let status: number | undefined;
  ws.once("open", () => { status = 101; });
  ws.once("unexpected-response", (_request, response) => {
    status = response.statusCode;
    response.resume();
    ws.terminate();
  });
  ws.on("error", () => {});
  await expect.poll(() => status, { timeout: 3000 }).toBeDefined();
  return { ws, messages, status: status! };
}

function openBrowser(base: string, credential?: string, origin = base) {
  return openSocket(`${base.replace("http:", "ws:")}/ws`, {
    Origin: origin,
    ...(credential ? { Cookie: `${COOKIE_NAME}=${credential}` } : {}),
  });
}

async function openBridge(cwd?: string, bridgeToken?: string, headers: Record<string, string> = {}) {
  const bridge = await openSocket(`ws://127.0.0.1:${handle!.piPort}`, headers,
    bridgeToken ? ["pi-bridge", `pi-bridge-token.${bridgeToken}`] : []);
  expect(bridge.status).toBe(101);
  const sessionId = `bridge-${++sequence}`;
  if (cwd) {
    bridge.ws.send(JSON.stringify({ type: "session_register", sessionId, cwd, source: "tui" }));
    await expect.poll(() => handle!.server.sessionManager.get(sessionId), { timeout: 3000 }).toBeDefined();
  }
  return { ...bridge, sessionId };
}

async function browserSpawn(browser: SocketProbe, body: Record<string, unknown>) {
  const requestId = `spawn-${++sequence}`;
  browser.ws.send(JSON.stringify({ type: "spawn_session", requestId, ...body }));
  await expect.poll(() => browser.messages.find((m) => m.type === "spawn_result" && m.requestId === requestId), { timeout: 3000 }).toBeDefined();
  return browser.messages.find((m) => m.type === "spawn_result" && m.requestId === requestId);
}

async function settleBrowser(browser: SocketProbe) {
  const before = browser.messages.filter((m) => m.type === "pong").length;
  browser.ws.send(JSON.stringify({ type: "ping" }));
  await expect.poll(() => browser.messages.filter((m) => m.type === "pong").length, { timeout: 3000 }).toBeGreaterThan(before);
}

function clearEffects() {
  fixture.spawn.mockClear();
  fixture.preflight.mockClear();
  for (const queue of fixture.attachQueues) queue.enqueue.mockClear();
  for (const queue of fixture.bootstrapQueues) queue.enqueue.mockClear();
}

function expectNoSpawnEffects() {
  expect(fixture.spawn).not.toHaveBeenCalled();
  expect(fixture.preflight).not.toHaveBeenCalled();
  for (const queue of fixture.attachQueues) expect(queue.enqueue).not.toHaveBeenCalled();
  for (const queue of fixture.bootstrapQueues) {
    expect(queue.enqueue).not.toHaveBeenCalled();
    expect(queue.size()).toBe(0);
  }
}

describe.each([false, true])("assembled spawn boundary requireBrowserAuth=%s", (requireBrowserAuth) => {
  it("requires a verified operator for REST spawn, including direct loopback", async () => {
    const { cwd, base } = await start(requireBrowserAuth);
    const allowed = await post(base, "/api/session/spawn", { cwd }, token());
    expect(allowed.status).toBe(200);
    expect(fixture.spawn).toHaveBeenCalledOnce();
    fixture.spawn.mockClear();

    const denied = await post(base, "/api/session/spawn", { cwd });
    expect(denied.status).toBe(401);
    expect(fixture.spawn).not.toHaveBeenCalled();
  }, 20_000);

  it("rejects expired, invalid, wrong-operator and wrong-origin REST requests", async () => {
    const { cwd, base } = await start(requireBrowserAuth);
    const expired = jwt.sign({ sub: "op@example.com", username: "op", provider: "github" }, SECRET, { expiresIn: -1 });
    const malformed = jwt.sign({ sub: " ", username: "op", provider: "github" }, SECRET);
    for (const credential of [expired, malformed, token("op", "wrong-signing-key"), token("guest")]) {
      const response = await post(base, "/api/session/spawn", {
        cwd, principal: { sub: "op@example.com", username: "op" }, actor: "operator",
      }, credential);
      expect.soft([401, 403]).toContain(response.status);
    }
    const foreignOrigin = await post(base, "/api/session/spawn", { cwd }, token(), { Origin: "https://attacker.example" });
    expect.soft(foreignOrigin.status).toBe(403);
    expectNoSpawnEffects();
  }, 20_000);

  it("authorizes browser spawn from the bound operator, never frame-supplied identity", async () => {
    const { cwd, base } = await start(requireBrowserAuth);
    const operator = await openBrowser(base, token());
    expect(operator.status).toBe(101);
    expect(await browserSpawn(operator, { cwd })).toMatchObject({ success: true });
    expect(fixture.spawn).toHaveBeenCalledOnce();
    clearEffects();

    const expired = jwt.sign({ sub: "op@example.com", username: "op", provider: "github" }, SECRET, { expiresIn: -1 });
    const malformed = jwt.sign({ sub: " ", username: "op", provider: "github" }, SECRET);
    for (const credential of [undefined, expired, malformed, token("op", "wrong-signing-key"), token("guest")]) {
      const caller = await openBrowser(base, credential);
      if (caller.status === 101) {
        expect(await browserSpawn(caller, { cwd, principal: { sub: "op@example.com", username: "op" }, operator: true })).toMatchObject({ success: false });
      } else {
        expect([401, 403]).toContain(caller.status);
      }
    }
    const foreignOrigin = await openBrowser(base, token(), "https://attacker.example");
    if (foreignOrigin.status === 101) {
      expect(await browserSpawn(foreignOrigin, { cwd })).toMatchObject({ success: false });
    } else {
      expect(foreignOrigin.status).toBe(403);
    }
    expectNoSpawnEffects();
  }, 20_000);

  it("keeps operator /new forwarding but blocks unauthenticated and foreign-origin /new", async () => {
    const { cwd, base } = await start(requireBrowserAuth);
    const bridge = await openBridge(cwd, BRIDGE_TOKEN);
    const operator = await openBrowser(base, token());
    const route = `/api/session/${bridge.sessionId}/prompt`;
    expect((await post(base, route, { text: "/new" }, token())).status).toBe(200);
    await expect.poll(() => bridge.messages.filter((m) => m.type === "send_prompt" && m.text === "/new").length).toBe(1);
    operator.ws.send(JSON.stringify({ type: "send_prompt", sessionId: bridge.sessionId, text: "/new" }));
    await expect.poll(() => bridge.messages.filter((m) => m.type === "send_prompt" && m.text === "/new").length).toBe(2);

    const denied = await post(base, route, { text: "/new" });
    expect.soft([401, 403]).toContain(denied.status);
    const foreign = await post(base, route, { text: "/new" }, token(), { Origin: "https://attacker.example" });
    expect.soft(foreign.status).toBe(403);
    const anonymous = await openBrowser(base);
    if (anonymous.status === 101) {
      anonymous.ws.send(JSON.stringify({ type: "send_prompt", sessionId: bridge.sessionId, text: "/new" }));
      await settleBrowser(anonymous);
    }
    expect(bridge.messages.filter((m) => m.type === "send_prompt" && m.text === "/new")).toHaveLength(2);
    expectNoSpawnEffects();
  }, 20_000);

  it("denies untokened and wrong-token first-frame bridge spawn without claiming a session", async () => {
    const { cwd, base } = await start(requireBrowserAuth);
    const observer = await openBrowser(base, token());
    for (const bridgeToken of [undefined, "b".repeat(64)]) {
      const caller = await openBridge(undefined, bridgeToken);
      caller.ws.send(JSON.stringify({ type: "spawn_new_session", sessionId: "unowned", cwd }));
      await expect.poll(() => fixture.spawn.mock.calls.length > 0 || caller.messages.some((m) => m.type === "spawn_result"), { timeout: 3000 }).toBe(true);
      expectNoSpawnEffects();
      expect(caller.messages.find((m) => m.type === "spawn_result")).toMatchObject({ success: false });
      expect(handle!.server.sessionManager.get("unowned")).toBeUndefined();
      expect(caller.ws.readyState).toBe(WebSocket.OPEN);
    }
    await settleBrowser(observer);
    expect(observer.messages.some((m) => m.type === "spawn_result")).toBe(false);
  }, 20_000);

  it("lets a token-verified local bridge spawn for /new and replies to its source socket", async () => {
    const { cwd } = await start(requireBrowserAuth);
    const caller = await openBridge(cwd, BRIDGE_TOKEN);
    caller.ws.send(JSON.stringify({ type: "spawn_new_session", sessionId: caller.sessionId, cwd }));
    await expect.poll(() => caller.messages.find((m) => m.type === "spawn_result"), { timeout: 3000 }).toBeDefined();
    expect(caller.messages.find((m) => m.type === "spawn_result")).toMatchObject({ cwd, success: true });
    expect(fixture.spawn).toHaveBeenCalledOnce();
  }, 20_000);

  it("denies a valid-token bridge on a genuinely non-loopback trusted-network socket", async (context) => {
    const address = Object.values(os.networkInterfaces()).flat().find((entry) => entry?.family === "IPv4" && !entry.internal)?.address;
    if (!address) context.skip("No non-loopback IPv4 interface available for real-socket counterexample");
    const { cwd } = await start(requireBrowserAuth, "op", { piHost: "0.0.0.0", resolvedTrustedNetworks: [address!] });
    const local = await openBridge(cwd, BRIDGE_TOKEN);
    local.ws.send(JSON.stringify({ type: "spawn_new_session", sessionId: local.sessionId, cwd }));
    await expect.poll(() => local.messages.find((m) => m.type === "spawn_result"), { timeout: 3000 }).toBeDefined();
    expect(local.messages.find((m) => m.type === "spawn_result")).toMatchObject({ success: true });
    expect(fixture.spawn).toHaveBeenCalledOnce();
    clearEffects();

    const remote = await openSocket(`ws://${address}:${handle!.piPort}`, { "x-pi-bridge-token": BRIDGE_TOKEN });
    expect(remote.status).toBe(101);
    // TCP source address, not X-Forwarded-For, proves the server sees a remote peer.
    expect((remote.ws as WebSocket & { _socket: { localAddress: string } })._socket.localAddress).toBe(address);
    remote.ws.send(JSON.stringify({ type: "spawn_new_session", sessionId: "unowned-remote", cwd }));
    await expect.poll(() => remote.messages.find((m) => m.type === "spawn_result"), { timeout: 3000 }).toBeDefined();
    expect(remote.messages.find((m) => m.type === "spawn_result")).toMatchObject({ success: false });
    expectNoSpawnEffects();
    expect(handle!.server.sessionManager.get("unowned-remote")).toBeUndefined();
  }, 20_000);

  it("denies a valid local bridge token when localBridgeOperator is null", async () => {
    const { cwd } = await start(requireBrowserAuth, null);
    const caller = await openBridge(cwd, BRIDGE_TOKEN);
    caller.ws.send(JSON.stringify({ type: "spawn_new_session", sessionId: caller.sessionId, cwd }));
    await expect.poll(() => fixture.spawn.mock.calls.length > 0 || caller.messages.some((m) => m.type === "spawn_result"), { timeout: 3000 }).toBe(true);
    expectNoSpawnEffects();
    expect(caller.messages.find((m) => m.type === "spawn_result")).toMatchObject({ success: false });
  }, 20_000);

  it("denies delegated spawn through a forwarded connection even with a valid token", async () => {
    const { cwd } = await start(requireBrowserAuth);
    const caller = await openBridge(cwd, BRIDGE_TOKEN, { "X-Forwarded-For": "100.100.100.100" });
    caller.ws.send(JSON.stringify({ type: "spawn_new_session", sessionId: caller.sessionId, cwd }));
    await expect.poll(() => fixture.spawn.mock.calls.length > 0 || caller.messages.some((m) => m.type === "spawn_result"), { timeout: 3000 }).toBe(true);
    expectNoSpawnEffects();
    expect(caller.messages.find((m) => m.type === "spawn_result")).toMatchObject({ success: false });
  }, 20_000);

  it("keeps untokened legacy registration, telemetry, prompt and abort working", async () => {
    const { cwd, base } = await start(requireBrowserAuth);
    const legacy = await openBridge(cwd);
    legacy.ws.send(JSON.stringify({ type: "session_heartbeat", sessionId: legacy.sessionId }));
    await expect.poll(() => legacy.messages.some((m) => m.type === "heartbeat_ack")).toBe(true);
    legacy.ws.send(JSON.stringify({ type: "event_forward", sessionId: legacy.sessionId, event: { eventType: "agent_start", timestamp: Date.now(), data: {} } }));
    await expect.poll(() => handle!.server.sessionManager.get(legacy.sessionId)?.status).toBe("streaming");

    const operator = await openBrowser(base, token());
    operator.ws.send(JSON.stringify({ type: "send_prompt", sessionId: legacy.sessionId, text: "legacy conversation" }));
    await expect.poll(() => legacy.messages.some((m) => m.type === "send_prompt" && m.text === "legacy conversation")).toBe(true);
    operator.ws.send(JSON.stringify({ type: "abort", sessionId: legacy.sessionId }));
    await expect.poll(() => legacy.messages.some((m) => m.type === "abort")).toBe(true);
    expect(legacy.ws.readyState).toBe(WebSocket.OPEN);
    expectNoSpawnEffects();
  }, 20_000);

  it("rejects runtime and cwd violations before preflight, attachment, bootstrap or spawn effects", async () => {
    const { cwd, outside, base } = await start(requireBrowserAuth);
    const operator = await openBrowser(base, token());
    expect(await browserSpawn(operator, { cwd, attachProposal: "allowed-control" })).toMatchObject({ success: true });
    expect(fixture.preflight).toHaveBeenCalledOnce();
    expect(fixture.attachQueues.at(-1)!.enqueue).toHaveBeenCalledOnce();
    clearEffects();

    handle!.server.bootstrapState.set({ status: "installing" });
    const escapingLink = path.join(cwd, "escape");
    fs.symlinkSync(outside, escapingLink, "dir");
    for (const body of [{ cwd, runtime: "unknown-runtime" }, { cwd: outside }, { cwd: escapingLink }]) {
      const response = await post(base, "/api/session/spawn", body, token());
      expect.soft(response.status).toBe(403);
      expect(await browserSpawn(operator, { ...body, attachProposal: "forbidden-attachment" })).toMatchObject({ success: false });
    }
    expectNoSpawnEffects();
    for (const queue of fixture.attachQueues) {
      expect(queue.size(outside)).toBe(0);
      expect(queue.size(cwd)).toBe(1); // Only the authorized positive-control intent survives.
    }
  }, 20_000);
});
