import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import { discoverPlugins } from "@blackbelt-technology/dashboard-plugin-runtime/server";
import type { AuthConfig } from "@blackbelt-technology/pi-dashboard-shared/config.js";
import { signToken, COOKIE_NAME } from "../../auth.js";
import { createTestServer, type TestServerHandle } from "../../test-support/test-server.js";
import * as preflight from "../../spawn-preflight.js";
import type { CodexAdapterOptions } from "../codex-adapter.js";
import type { RuntimeSendInput } from "../types.js";

const fixture = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const originalHome = process.env.HOME;
  if (!originalHome || originalHome === os.userInfo().homedir) throw new Error("Isolated test HOME required");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-ingress-"));
  process.env.HOME = home;
  fs.mkdirSync(path.join(home, ".pi", "agent", "sessions"), { recursive: true });
  fs.mkdirSync(path.join(home, ".pi", "dashboard"), { recursive: true });
  return { home, originalHome, createAdapter: vi.fn(), piSpawn: vi.fn() };
});

vi.mock("../codex-adapter.js", () => ({ createCodexAdapter: fixture.createAdapter }));
vi.mock("../../process-manager.js", async (original) => ({
  ...await original<typeof import("../../process-manager.js")>(),
  spawnPiSession: fixture.piSpawn,
}));

const SECRET = "codex-ingress-test-signing-key";
const adapters: ReturnType<typeof makeAdapter>[] = [];
const sockets: WebSocket[] = [];
let handle: TestServerHandle | undefined;
let sequence = 0;

function makeAdapter(options: CodexAdapterOptions) {
  // No real child/PID exists; the real manager still receives lifecycle callbacks.
  const process = Object.assign(new EventEmitter(), { pid: undefined });
  const threadId = options.threadId ?? `native-thread-${++sequence}`;
  let streaming = false;
  const emit = (eventType: string, data: Record<string, unknown> = {}) => options.onEvent({ eventType, data, timestamp: Date.now() });
  const finish = () => { streaming = false; emit("agent_end"); };
  options.onProcess(process as any);
  options.onThread({ threadId, threadPath: path.join(fixture.home, `${threadId}.jsonl`), model: "fixture-model" });
  return {
    runtime: "codex" as const, threadId, process, pid: undefined,
    isStreaming: () => streaming,
    send: vi.fn(async (input: RuntimeSendInput) => {
      if (streaming) throw new Error("Codex turn already active");
      streaming = true;
      emit("agent_start");
      emit("message_start", { message: { role: "user", content: [{ type: "text", text: input.text }] }, author: input.author });
      if (input.text === "wait") return;
      const message = { role: "assistant", content: [{ type: "text", text: `response:${input.text}` }] };
      emit("message_start", { message: { role: "assistant", content: [] } });
      emit("message_update", { message });
      emit("message_end", { message });
      finish();
    }),
    abort: vi.fn(async () => { if (streaming) finish(); }),
    dispose: vi.fn(async () => { if (streaming) finish(); process.emit("exit", 0); options.onExit(); }),
  };
}

beforeEach(() => {
  fs.rmSync(path.join(fixture.home, ".pi", "dashboard", "codex-sessions"), { recursive: true, force: true });
  fixture.createAdapter.mockReset().mockImplementation(async (options: CodexAdapterOptions) => {
    const adapter = makeAdapter(options);
    adapters.push(adapter);
    return adapter;
  });
  fixture.piSpawn.mockReset().mockResolvedValue({ success: true, message: "fixture pi spawn" });
  adapters.length = 0;
  vi.spyOn(preflight, "preflightSpawn");
});

async function stop() {
  for (const socket of sockets.splice(0)) socket.terminate();
  if (handle) await handle.stop();
  handle = undefined;
}

afterEach(async () => { await stop(); vi.restoreAllMocks(); });
afterAll(() => { process.env.HOME = fixture.originalHome; fs.rmSync(fixture.home, { recursive: true, force: true }); });

function token(username = "op") {
  return signToken({ sub: `${username}@example.com`, username, name: username, provider: "github" }, SECRET);
}

async function start(requireBrowserAuth = false, existingCwd?: string, settings: { autoShutdown?: boolean; shutdownIdleSeconds?: number } = {}) {
  const cwd = existingCwd ?? path.join(fixture.home, `project-${++sequence}`);
  fs.mkdirSync(cwd, { recursive: true });
  const authConfig: AuthConfig = { secret: SECRET, providers: { github: { clientId: "test", clientSecret: "test" } },
    allowedUsers: ["op", "guest"], operatorUsers: ["op"], requireBrowserAuth, localBridgeOperator: "op" };
  const dashboardDir = path.join(fixture.home, ".pi", "dashboard");
  fs.writeFileSync(path.join(dashboardDir, "config.json"), JSON.stringify({ auth: authConfig, spawnStrategy: "headless",
    runtimes: { codex: { enabled: true } }, plugins: Object.fromEntries(discoverPlugins().map(({ manifest }) => [manifest.id, { enabled: false }])) }));
  fs.writeFileSync(path.join(dashboardDir, "preferences.json"), JSON.stringify({ pinnedDirectories: [cwd], sessionOrder: {} }));
  handle = await createTestServer({ authConfig, pingInterval: 0, resurrectionSweepMs: 0, runtimes: { codex: { enabled: true } }, ...settings });
  return { cwd, base: `http://127.0.0.1:${handle.httpPort}` };
}

function post(base: string, route: string, body: unknown, credential: string | null = token()) {
  return fetch(`${base}${route}`, { method: "POST", headers: { "Content-Type": "application/json", ...(credential ? { Cookie: `${COOKIE_NAME}=${credential}` } : {}) }, body: JSON.stringify(body) });
}

interface BrowserProbe { ws: WebSocket; messages: any[]; status: number }

async function browser(base: string, credential: string | null = token()): Promise<BrowserProbe> {
  const ws = new WebSocket(`${base.replace("http:", "ws:")}/ws`, { headers: { Origin: base, ...(credential ? { Cookie: `${COOKIE_NAME}=${credential}` } : {}) } });
  sockets.push(ws);
  const messages: any[] = [];
  ws.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
  let status: number | undefined;
  ws.once("open", () => { status = 101; });
  ws.once("unexpected-response", (_request, response) => { status = response.statusCode; response.resume(); ws.terminate(); });
  ws.on("error", () => {});
  await expect.poll(() => status, { timeout: 3000 }).toBeDefined();
  return { ws, messages, status: status! };
}

async function settle(caller: BrowserProbe) {
  const before = caller.messages.filter((message) => message.type === "pong").length;
  caller.ws.send(JSON.stringify({ type: "ping" }));
  await expect.poll(() => caller.messages.filter((message) => message.type === "pong").length, { timeout: 3000 }).toBeGreaterThan(before);
}

async function spawnRest(base: string, cwd: string) {
  const response = await post(base, "/api/session/spawn", { cwd, runtime: "codex" });
  expect(response.status, await response.text()).toBe(200);
  const session = handle!.server.sessionManager.listAll().filter((session) => session.runtime === "codex").at(-1);
  expect(session?.codexThreadId).toBeTruthy();
  return session!;
}

async function replay(caller: BrowserProbe, sessionId: string) {
  const before = caller.messages.length;
  caller.ws.send(JSON.stringify({ type: "subscribe", sessionId, lastSeq: 0 }));
  await expect.poll(() => caller.messages.slice(before).some((message) => message.type === "event_replay" && message.sessionId === sessionId && message.isLast), { timeout: 3000 }).toBe(true);
  return caller.messages.slice(before).filter((message) => message.type === "event_replay" && message.sessionId === sessionId).flatMap((message) => message.events);
}

function userText(events: any[]) {
  return events.filter(({ event }) => event.eventType === "message_start" && event.data.message?.role === "user").map(({ event }) => event.data.message.content[0].text);
}

describe.each([false, true])("assembled Codex runtime ingress requireBrowserAuth=%s", (requireBrowserAuth) => {
  it("keeps an attached Codex conversation alive without pi bridges or terminals", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const { cwd, base } = await start(requireBrowserAuth, undefined, { autoShutdown: true, shutdownIdleSeconds: 0.2 });
    await spawnRest(base, cwd);
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(exit).not.toHaveBeenCalled();
    expect(adapters[0].dispose).not.toHaveBeenCalled();
  });
  it("selects Codex over pi and bypasses pi bootstrap/preflight for an authorized REST spawn", async () => {
    const { cwd, base } = await start(requireBrowserAuth);
    expect((await post(base, "/api/session/spawn", { cwd, runtime: "pi" })).status).toBe(200);
    expect(fixture.piSpawn).toHaveBeenCalledOnce();
    fixture.piSpawn.mockClear();
    handle!.server.bootstrapState.set({ status: "installing" });
    const response = await post(base, "/api/session/spawn", { cwd, runtime: "codex" });
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.success).toBe(true);
    expect(fixture.createAdapter).toHaveBeenCalledOnce();
    expect(fixture.piSpawn).not.toHaveBeenCalled();
    expect(preflight.preflightSpawn).not.toHaveBeenCalled();
    expect(handle!.server.sessionManager.listAll().filter((session) => session.runtime === "codex")).toHaveLength(1);
  }, 20_000);

  it("selects Codex from browser spawn and correlates the server-stamped session id", async () => {
    const { cwd, base } = await start(requireBrowserAuth);
    handle!.server.bootstrapState.set({ status: "installing" });
    const caller = await browser(base);
    expect(caller.status).toBe(101);
    const requestId = `spawn-${++sequence}`;
    caller.ws.send(JSON.stringify({ type: "spawn_session", cwd, runtime: "codex", requestId, sessionId: "forged-id", attachProposal: "native-work" }));
    await expect.poll(() => caller.messages.find((message) => message.type === "spawn_result" && message.requestId === requestId), { timeout: 3000 }).toBeDefined();
    expect(caller.messages.find((message) => message.type === "spawn_result" && message.requestId === requestId)).toMatchObject({ success: true });
    await expect.poll(() => caller.messages.find((message) => message.type === "session_added" && message.spawnRequestId === requestId), { timeout: 3000 }).toBeDefined();
    const added = caller.messages.find((message) => message.type === "session_added" && message.spawnRequestId === requestId);
    expect(added.session).toMatchObject({ id: expect.stringMatching(/^codex-/), runtime: "codex", source: "dashboard", attachedProposal: "native-work", codexThreadId: adapters[0].threadId });
    expect(added.session.id).not.toBe("forged-id");
    expect(added.session.sessionFile).toBeUndefined();
    expect(fixture.createAdapter).toHaveBeenCalledOnce();
    expect(fixture.piSpawn).not.toHaveBeenCalled();
    expect(preflight.preflightSpawn).not.toHaveBeenCalled();
  }, 20_000);

  it("denies anonymous and nonoperator Codex launches at both ingress paths", async () => {
    const { cwd, base } = await start(requireBrowserAuth);
    await spawnRest(base, cwd); // Positive control establishes enabled runtime + valid operator.
    fixture.createAdapter.mockClear();
    for (const credential of [null, token("guest")]) {
      const response = await post(base, "/api/session/spawn", { cwd, runtime: "codex" }, credential);
      expect([401, 403]).toContain(response.status);
      const caller = await browser(base, credential);
      if (caller.status === 101) {
        const requestId = `denied-${++sequence}`;
        caller.ws.send(JSON.stringify({ type: "spawn_session", cwd, runtime: "codex", requestId, principal: { sub: "op@example.com", username: "op" } }));
        await expect.poll(() => caller.messages.find((message) => message.type === "spawn_result" && message.requestId === requestId), { timeout: 3000 }).toBeDefined();
        expect(caller.messages.find((message) => message.type === "spawn_result" && message.requestId === requestId)).toMatchObject({ success: false });
      } else {
        expect([401, 403]).toContain(caller.status);
      }
    }
    expect(fixture.createAdapter).not.toHaveBeenCalled();
    expect(fixture.piSpawn).not.toHaveBeenCalled();
    expect(preflight.preflightSpawn).not.toHaveBeenCalled();
  }, 20_000);

  it.each(["rest", "browser"] as const)("routes multiple turns, abort and shutdown through the same native adapter via %s", async (transport) => {
    const { cwd, base } = await start(requireBrowserAuth);
    const session = await spawnRest(base, cwd);
    const caller = await browser(base);
    await replay(caller, session.id);
    async function action(kind: "prompt" | "abort" | "shutdown", text?: string) {
      if (transport === "rest") {
        expect((await post(base, `/api/session/${session.id}/${kind}`, text ? { text } : {})).status).toBe(200);
      } else {
        caller.ws.send(JSON.stringify({ type: kind === "prompt" ? "send_prompt" : kind, sessionId: session.id, ...(text ? { text } : {}) }));
        await settle(caller);
      }
    }
    await action("prompt", "first turn");
    await expect.poll(() => caller.messages.some((message) => message.type === "event" && message.event.data.message?.content?.[0]?.text === "response:first turn"), { timeout: 3000 }).toBe(true);
    await action("prompt", "second turn");
    await expect.poll(() => adapters[0].send.mock.calls.length).toBe(2);
    expect(adapters[0].send.mock.calls.map(([input]) => input.text)).toEqual(["first turn", "second turn"]);
    expect(fixture.createAdapter).toHaveBeenCalledOnce();
    await action("prompt", "wait");
    await expect.poll(() => handle!.server.sessionManager.get(session.id)?.status).toBe("streaming");
    await action("abort");
    await expect.poll(() => adapters[0].abort.mock.calls.length).toBe(1);
    await expect.poll(() => handle!.server.sessionManager.get(session.id)?.status).toBe("idle");
    await action("shutdown");
    await expect.poll(() => adapters[0].dispose.mock.calls.length).toBe(1);
    await expect.poll(() => handle!.server.sessionManager.get(session.id)?.status).toBe("ended");
    expect(fixture.piSpawn).not.toHaveBeenCalled();
    expect(preflight.preflightSpawn).not.toHaveBeenCalled();

    if (transport === "browser") {
      caller.ws.send(JSON.stringify({ type: "resume_session", sessionId: session.id, mode: "continue", requestId: "resume-native" }));
      await expect.poll(() => caller.messages.find((message) => message.type === "resume_result" && message.sessionId === session.id), { timeout: 3000 }).toBeDefined();
      expect(caller.messages.find((message) => message.type === "resume_result" && message.sessionId === session.id)).toMatchObject({ success: true });
      expect(fixture.createAdapter).toHaveBeenCalledTimes(2);
      expect(adapters[1].threadId).toBe(session.codexThreadId);
    }
  }, 20_000);

  it("rejects pi reload and fork for Codex without falling into the pi launch path", async () => {
    const { cwd, base } = await start(requireBrowserAuth);
    const session = await spawnRest(base, cwd);
    const caller = await browser(base);
    const reload = await post(base, `/api/session/${session.id}/prompt`, { text: "/reload" });
    expect(reload.status).toBeGreaterThanOrEqual(400);
    caller.ws.send(JSON.stringify({ type: "send_prompt", sessionId: session.id, text: "/reload" }));
    await settle(caller);
    expect(adapters[0].send).not.toHaveBeenCalled();

    expect((await post(base, `/api/session/${session.id}/shutdown`, {})).status).toBe(200);
    const fork = await post(base, `/api/session/${session.id}/resume`, { mode: "fork" });
    expect(fork.status).toBeGreaterThanOrEqual(400);
    caller.ws.send(JSON.stringify({ type: "resume_session", sessionId: session.id, mode: "fork", requestId: "unsupported-fork" }));
    await expect.poll(() => caller.messages.find((message) => message.type === "resume_result" && message.sessionId === session.id), { timeout: 3000 }).toBeDefined();
    expect(caller.messages.find((message) => message.type === "resume_result" && message.sessionId === session.id)).toMatchObject({ success: false });
    expect(fixture.createAdapter).toHaveBeenCalledOnce();
    expect(fixture.piSpawn).not.toHaveBeenCalled();
    expect(preflight.preflightSpawn).not.toHaveBeenCalled();
  }, 20_000);

  it("restores cold after restart, reloads evicted history and resumes the original native thread", async () => {
    const { cwd, base } = await start(requireBrowserAuth);
    const session = await spawnRest(base, cwd);
    expect((await post(base, `/api/session/${session.id}/prompt`, { text: "persistent prompt" })).status).toBe(200);
    expect(handle!.server.eventStore.hasEvents(session.id)).toBe(true);
    await stop();
    expect(adapters[0].dispose).toHaveBeenCalledOnce();

    const restarted = await start(requireBrowserAuth, cwd);
    const restored = handle!.server.sessionManager.get(session.id);
    expect(restored).toMatchObject({ runtime: "codex", codexThreadId: session.codexThreadId, status: "ended" });
    expect(restored?.sessionFile).toBeUndefined();
    expect(fixture.createAdapter).toHaveBeenCalledOnce();
    const listed = await fetch(`${restarted.base}/api/sessions`, { headers: { Cookie: `${COOKIE_NAME}=${token()}` } });
    expect(listed.status).toBe(200);
    expect((await listed.json()).data.find((row: any) => row.id === session.id)).toMatchObject({ status: "ended", hidden: true });
    const caller = await browser(restarted.base);
    await expect.poll(() => caller.messages.find(message => message.type === "sessions_snapshot"), { timeout: 3000 }).toBeDefined();
    const browserSession = { ...caller.messages.find(message => message.type === "sessions_snapshot").sessions.find((row: any) => row.id === session.id) };
    expect(browserSession).toMatchObject({ status: "ended", hidden: true });
    const initialReplay = await replay(caller, session.id);
    expect(userText(initialReplay)).toContain("persistent prompt");
    expect(fixture.createAdapter).toHaveBeenCalledOnce(); // Viewing history never launches a process.

    expect(handle!.server.eventStore.deleteEventsForSession(session.id)).toBeGreaterThan(0);
    expect(handle!.server.eventStore.hasEvents(session.id)).toBe(false);
    caller.ws.send(JSON.stringify({ type: "unsubscribe", sessionId: session.id }));
    await settle(caller);
    const afterEviction = await replay(caller, session.id);
    expect(userText(afterEviction)).toEqual(userText(initialReplay));
    expect(fixture.createAdapter).toHaveBeenCalledOnce();

    const seq = afterEviction.find(({ event }: any) => event.eventType === "message_start" && event.data.message?.role === "user").seq;
    handle!.server.eventStore.deleteEventsForSession(session.id);
    const event = await fetch(`${restarted.base}/api/events/${session.id}/${seq}`, { headers: { Cookie: `${COOKIE_NAME}=${token()}` } });
    expect(event.status).toBe(200);
    expect(await event.text()).toContain("persistent prompt");

    expect((await post(restarted.base, `/api/session/${session.id}/resume`, { mode: "continue" })).status).toBe(200);
    await settle(caller);
    for (const message of caller.messages) {
      if (message.type === "session_updated" && message.sessionId === session.id) Object.assign(browserSession, message.updates);
    }
    expect(handle!.server.sessionManager.get(session.id)).toMatchObject({ status: "idle", hidden: false });
    expect(browserSession).toMatchObject({ status: "idle", endedAt: null, hidden: false, dataUnavailable: false, model: "fixture-model" });
    expect(fixture.createAdapter).toHaveBeenCalledTimes(2);
    expect(fixture.createAdapter).toHaveBeenLastCalledWith(expect.objectContaining({ threadId: session.codexThreadId }));
    expect((await post(restarted.base, `/api/session/${session.id}/prompt`, { text: "after restart" })).status).toBe(200);
    expect(adapters[1].send).toHaveBeenCalledWith(expect.objectContaining({ text: "after restart" }));
    expect(fixture.piSpawn).not.toHaveBeenCalled();
  }, 25_000);

  it("does not let a bridge claim or mutate a server-owned Codex session", async () => {
    const { cwd, base } = await start(requireBrowserAuth);
    const session = await spawnRest(base, cwd);
    const before = handle!.server.eventStore.getMaxSeq(session.id);
    const bridge = new WebSocket(`ws://127.0.0.1:${handle!.piPort}`);
    sockets.push(bridge);
    bridge.on("error", () => {});
    await new Promise<void>((resolve, reject) => { bridge.once("open", resolve); bridge.once("error", reject); });
    let pong = false;
    bridge.on("pong", () => { pong = true; });
    bridge.send(JSON.stringify({ type: "session_register", sessionId: session.id, cwd: "/forged", source: "tui", runtime: "pi", codexThreadId: "forged" }));
    bridge.send(JSON.stringify({ type: "event_forward", sessionId: session.id, event: { eventType: "agent_start", timestamp: Date.now(), data: {} } }));
    bridge.ping();
    await expect.poll(() => pong || bridge.readyState === WebSocket.CLOSED, { timeout: 3000 }).toBe(true);
    expect(handle!.server.sessionManager.get(session.id)).toMatchObject({ runtime: "codex", codexThreadId: session.codexThreadId, cwd: session.cwd, source: "dashboard", status: "idle" });
    expect(handle!.server.eventStore.getMaxSeq(session.id)).toBe(before);
    expect(fixture.createAdapter).toHaveBeenCalledOnce();
  }, 20_000);
});
