import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, type ServerOptions } from "ws";
import type { ExtensionToServerMessage } from "@blackbelt-technology/pi-dashboard-shared/protocol.js";
import { createPiGateway, type BridgeConnectionContext, type PiGateway, type PiGatewayOptions } from "../pi-gateway.js";

const serverOptions = vi.hoisted(() => [] as ServerOptions[]);
vi.mock("ws", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ws")>();
  return {
    ...actual,
    WebSocketServer: class extends actual.WebSocketServer {
      constructor(options: ServerOptions) {
        super(options);
        serverOptions.push(options);
      }
    },
  };
});

const TOKEN = "a".repeat(64);
const WRONG_TOKEN = "b".repeat(64);
const clients: WebSocket[] = [];
const gateways: PiGateway[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.terminate();
  for (const gateway of gateways.splice(0)) gateway.stop();
  serverOptions.length = 0;
});

async function fixture(options: PiGatewayOptions = {}) {
  const sessions = new Map<string, Record<string, unknown>>();
  const manager = {
    register: vi.fn((value: { id: string }) => {
      const session = { ...value, status: "active" };
      sessions.set(value.id, session);
      return session;
    }),
    get: (id: string) => sessions.get(id),
    update: vi.fn(),
    unregister: vi.fn((id: string) => sessions.delete(id)),
    listActive: () => [...sessions.values()],
    listAll: () => [...sessions.values()],
  };
  const events: Array<{
    sessionId: string;
    message: ExtensionToServerMessage;
    connection: BridgeConnectionContext;
  }> = [];
  const gateway = createPiGateway(manager as never, { pingInterval: 0, ...options });
  gateways.push(gateway);
  gateway.onEvent = (sessionId, message, connection) => {
    events.push({ sessionId, message, connection });
  };
  gateway.start(0);
  await expect.poll(() => gateway.status()).toBe("listening");
  return { gateway, manager, events, port: gateway.address()! };
}

async function connect(port: number, options: { headers?: Record<string, string>; protocols?: string[] } = {}) {
  const client = new WebSocket(`ws://127.0.0.1:${port}`, options.protocols ?? [], { headers: options.headers });
  clients.push(client);
  await new Promise<void>((resolve, reject) => {
    client.once("open", resolve);
    client.once("error", reject);
  });
  return client;
}

describe("bridge socket spawn boundary", () => {
  it("bridge first frames cannot claim server-owned Codex ids, while ordinary pi registration still works", async () => {
    const { gateway, manager, events, port } = await fixture();
    const codex = { id: "codex-owned", runtime: "codex", cwd: "/codex", codexThreadId: "native-thread", source: "dashboard" };
    manager.register(codex);
    const expected = { ...manager.get(codex.id) };
    const client = await connect(port);
    client.send(JSON.stringify({ type: "session_register", sessionId: codex.id, cwd: "/forged", source: "tui", runtime: "pi" }));
    client.send(JSON.stringify({ type: "session_register", sessionId: "ordinary-pi", cwd: "/tmp", source: "tui", runtime: "codex" }));
    await expect.poll(() => events.some(event => event.sessionId === "ordinary-pi")).toBe(true);
    expect(manager.get(codex.id)).toEqual(expected);
    expect(gateway.isSessionConnected(codex.id)).toBe(false);
    expect(events.some(event => event.sessionId === codex.id)).toBe(false);
    expect(manager.get("ordinary-pi")?.runtime).toBeUndefined();
    expect(gateway.isSessionConnected("ordinary-pi")).toBe(true);
  });

  it("registered pi sockets cannot mutate, unregister or forward events under a Codex id", async () => {
    const { gateway, manager, events, port } = await fixture();
    manager.register({ id: "codex-owned", runtime: "codex", cwd: "/codex", source: "dashboard" } as never);
    const expected = { ...manager.get("codex-owned") };
    const client = await connect(port);
    client.send(JSON.stringify({ type: "session_register", sessionId: "ordinary-pi", cwd: "/tmp", source: "tui" }));
    await expect.poll(() => gateway.isSessionConnected("ordinary-pi")).toBe(true);
    for (const frame of [
      { type: "session_heartbeat", metrics: { cpuPercent: 99 } },
      { type: "model_update", model: "forged/model" },
      { type: "event_forward", event: { eventType: "agent_start", timestamp: 1, data: {} } },
      { type: "session_unregister" },
      { type: "spawn_new_session", cwd: "/tmp" },
      { type: "session_register", cwd: "/forged", source: "tui" },
    ]) client.send(JSON.stringify({ ...frame, sessionId: "codex-owned" }));
    await new Promise<void>(resolve => { client.once("pong", () => resolve()); client.ping(); });
    expect(manager.get("codex-owned")).toEqual(expected);
    expect(gateway.isSessionConnected("codex-owned")).toBe(false);
    expect(gateway.isSessionConnected("ordinary-pi")).toBe(true);
    expect(events).toHaveLength(1);
    expect(manager.update).not.toHaveBeenCalled();
    expect(manager.unregister).not.toHaveBeenCalled();
  });

  it("a socket's previously bound id does not retain mutation rights if the server restores it as Codex", async () => {
    const { gateway, manager, events, port } = await fixture();
    const client = await connect(port);
    client.send(JSON.stringify({ type: "session_register", sessionId: "restored", cwd: "/tmp", source: "tui" }));
    await expect.poll(() => gateway.isSessionConnected("restored")).toBe(true);
    manager.register({ id: "restored", runtime: "codex", cwd: "/codex", source: "dashboard" } as never);
    manager.update.mockClear(); manager.unregister.mockClear();
    client.send(JSON.stringify({ type: "sessions_list", cwd: "/tmp", sessions: [] }));
    await new Promise<void>(resolve => { client.once("pong", () => resolve()); client.ping(); });
    expect(events).toHaveLength(1);
    expect(manager.update).not.toHaveBeenCalled();
    expect(manager.unregister).not.toHaveBeenCalled();
  });

  it("binds loopback by default; explicit host override stays available", async () => {
    await fixture();
    expect(serverOptions.at(-1)?.host).toBe("127.0.0.1");
    await fixture({ host: "0.0.0.0" });
    expect(serverOptions.at(-1)?.host).toBe("0.0.0.0");
  });

  it.each([undefined, WRONG_TOKEN])("phase one keeps telemetry/converse connected with token %s", async (token) => {
    const { gateway, events, port } = await fixture({ expectedBridgeToken: TOKEN });
    const client = await connect(port, { headers: token ? { "x-pi-bridge-token": token } : undefined });
    client.send(JSON.stringify({ type: "session_register", sessionId: "legacy", cwd: "/tmp", source: "tui" }));
    await expect.poll(() => events.length).toBe(1);
    expect(client.readyState).toBe(WebSocket.OPEN);
    expect(gateway.isSessionConnected("legacy")).toBe(true);
    expect(events[0].connection).toMatchObject({
      remoteAddress: "127.0.0.1", origin: null, forwarded: false,
      presentedBridgeToken: token ?? null, trusted: false,
    });
    const received = new Promise<string>((resolve) => client.once("message", (data) => resolve(data.toString())));
    expect(gateway.sendToSession("legacy", { type: "heartbeat_ack" })).toBe(true);
    expect(JSON.parse(await received)).toEqual({ type: "heartbeat_ack" });
  });

  it("captures valid header token once and never trusts frame-supplied connection fields", async () => {
    const { events, port } = await fixture({ expectedBridgeToken: TOKEN });
    const client = await connect(port, { headers: { "x-pi-bridge-token": TOKEN } });
    client.send(JSON.stringify({
      type: "spawn_new_session", sessionId: "invented", cwd: "/tmp",
      remoteAddress: "203.0.113.5", origin: "https://forged.example", trusted: false,
      presentedBridgeToken: WRONG_TOKEN,
    }));
    await expect.poll(() => events.length).toBe(1);
    expect(events[0].connection).toMatchObject({
      remoteAddress: "127.0.0.1", origin: null, forwarded: false,
      presentedBridgeToken: TOKEN, trusted: true,
    });
    expect(Object.isFrozen(events[0].connection)).toBe(true);
    client.send(JSON.stringify({ type: "spawn_new_session", sessionId: "another", cwd: "/tmp" }));
    await expect.poll(() => events.length).toBe(2);
    expect(events[1].connection).toBe(events[0].connection);
  });

  it("accepts native WebSocket token subprotocol without negotiating the secret", async () => {
    const { events, port } = await fixture({ expectedBridgeToken: TOKEN });
    const client = await connect(port, { protocols: ["pi-bridge", `pi-bridge-token.${TOKEN}`] });
    client.send(JSON.stringify({ type: "spawn_new_session", sessionId: "local", cwd: "/tmp" }));
    await expect.poll(() => events.length).toBe(1);
    expect(client.protocol).toBe("pi-bridge");
    expect(events[0].connection).toMatchObject({ presentedBridgeToken: TOKEN, trusted: true });
  });

  it("conflicting header and subprotocol tokens invalidate both trust and presented token", async () => {
    const { events, port } = await fixture({ expectedBridgeToken: TOKEN });
    const client = await connect(port, {
      headers: { "x-pi-bridge-token": TOKEN },
      protocols: ["pi-bridge", `pi-bridge-token.${WRONG_TOKEN}`],
    });
    client.send(JSON.stringify({ type: "spawn_new_session", sessionId: "local", cwd: "/tmp" }));
    await expect.poll(() => events.length).toBe(1);
    expect(events[0].connection).toMatchObject({ presentedBridgeToken: null, trusted: false });
  });

  it("preserves socket Origin and forwarding evidence without substituting forwarded IP", async () => {
    const { events, port } = await fixture({ expectedBridgeToken: TOKEN });
    const client = await connect(port, { headers: {
      "x-pi-bridge-token": TOKEN,
      Origin: "https://dashboard.example",
      "X-Forwarded-For": "198.51.100.42",
    } });
    client.send(JSON.stringify({ type: "spawn_new_session", sessionId: "local", cwd: "/tmp" }));
    await expect.poll(() => events.length).toBe(1);
    expect(events[0].connection).toMatchObject({
      remoteAddress: "127.0.0.1", origin: "https://dashboard.example", forwarded: true,
      trusted: true,
    });
  });

  it("first-frame spawn reaches authorization without placeholder creation or session displacement", async () => {
    const { gateway, manager, events, port } = await fixture({ expectedBridgeToken: TOKEN });
    const owner = await connect(port);
    owner.send(JSON.stringify({ type: "session_register", sessionId: "existing", cwd: "/tmp", source: "tui" }));
    await expect.poll(() => events.length).toBe(1);
    manager.register.mockClear();
    const ownerMessages: string[] = [];
    owner.on("message", (data) => ownerMessages.push(data.toString()));
    gateway.onEvent = (sessionId, message, connection) => {
      events.push({ sessionId, message, connection });
      connection?.send({ type: "heartbeat_ack" });
    };
    const caller = await connect(port);
    const reply = new Promise<string>((resolve) => caller.once("message", (data) => resolve(data.toString())));
    caller.send(JSON.stringify({ type: "spawn_new_session", sessionId: "existing", cwd: "/tmp" }));
    await expect.poll(() => events.length).toBe(2);
    expect(manager.register).not.toHaveBeenCalled();
    expect(events[1].sessionId).toBe("");
    expect(gateway.connectionCount()).toBe(1);
    expect(owner.readyState).toBe(WebSocket.OPEN);
    expect(JSON.parse(await reply)).toEqual({ type: "heartbeat_ack" });
    expect(ownerMessages).toEqual([]);
    caller.send(JSON.stringify({ type: "spawn_new_session", sessionId: "invented", cwd: "/tmp" }));
    await expect.poll(() => events.length).toBe(3);
    expect(manager.register).not.toHaveBeenCalled();
    expect(gateway.isSessionConnected("invented")).toBe(false);
  });

  it("registered spawn uses connection-bound session id and stops unregistered sockets on shutdown", async () => {
    const { gateway, events, port } = await fixture({ expectedBridgeToken: TOKEN });
    const registered = await connect(port);
    registered.send(JSON.stringify({ type: "session_register", sessionId: "bound", cwd: "/tmp", source: "tui" }));
    await expect.poll(() => events.length).toBe(1);
    registered.send(JSON.stringify({ type: "spawn_new_session", sessionId: "forged", cwd: "/tmp" }));
    await expect.poll(() => events.length).toBe(2);
    expect(events[1].sessionId).toBe("bound");
    const unregistered = await connect(port);
    unregistered.send(JSON.stringify({ type: "spawn_new_session", sessionId: "unused", cwd: "/tmp" }));
    await expect.poll(() => events.length).toBe(3);
    gateway.stop();
    await expect.poll(() => unregistered.readyState).toBe(WebSocket.CLOSED);
  });

  it.each([undefined, WRONG_TOKEN])("phase two rejects token %s before registration", async (token) => {
    const { manager, events, port } = await fixture({ expectedBridgeToken: TOKEN, requireBridgeToken: true });
    const client = new WebSocket(`ws://127.0.0.1:${port}`, { headers: token ? { "x-pi-bridge-token": token } : undefined });
    clients.push(client);
    let upgradeStatus: number | undefined;
    client.on("unexpected-response", (_request, response) => {
      upgradeStatus = response.statusCode;
      response.resume();
    });
    client.on("error", () => {});
    await expect.poll(() => upgradeStatus).toBe(401);
    expect(events).toEqual([]);
    expect(manager.register).not.toHaveBeenCalled();
  });

  it("phase two accepts valid token and fails closed when expected token absent", async () => {
    const valid = await fixture({ expectedBridgeToken: TOKEN, requireBridgeToken: true });
    const client = await connect(valid.port, { headers: { "x-pi-bridge-token": TOKEN } });
    client.send(JSON.stringify({ type: "session_register", sessionId: "verified", cwd: "/tmp", source: "tui" }));
    await expect.poll(() => valid.events.length).toBe(1);
    expect(valid.events[0].connection.trusted).toBe(true);

    const missing = await fixture({ requireBridgeToken: true });
    const denied = new WebSocket(`ws://127.0.0.1:${missing.port}`, { headers: { "x-pi-bridge-token": TOKEN } });
    clients.push(denied);
    let status: number | undefined;
    denied.on("unexpected-response", (_request, response) => {
      status = response.statusCode;
      response.resume();
    });
    denied.on("error", () => {});
    await expect.poll(() => status).toBe(401);
    expect(missing.manager.register).not.toHaveBeenCalled();
  });
});
