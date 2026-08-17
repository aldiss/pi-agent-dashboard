import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createBrowserGateway } from "../browser-gateway.js";
import { createMemoryEventStore } from "../memory-event-store.js";
import { createMemorySessionManager } from "../memory-session-manager.js";
import type { PiGateway } from "../pi-gateway.js";
import type { DashboardTranslator } from "../translator-service.js";

function makeFakeWs() {
  const ws = new EventEmitter() as EventEmitter & {
    send: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    readyState: number;
    OPEN: number;
    bufferedAmount: number;
  };
  ws.send = vi.fn();
  ws.close = vi.fn();
  ws.readyState = 1;
  ws.OPEN = 1;
  ws.bufferedAmount = 0;
  return ws;
}

function makeStubPiGateway(): PiGateway {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    sendToSession: vi.fn(),
    isSessionConnected: vi.fn(() => false),
    getConnectedSessionIds: vi.fn(() => []),
    hasSession: vi.fn(() => false),
    onEvent: vi.fn(),
  } as unknown as PiGateway;
}

function sentMessages(ws: ReturnType<typeof makeFakeWs>): Array<Record<string, any>> {
  return ws.send.mock.calls.map(([payload]) => JSON.parse(String(payload)));
}

function assistantEnd(entryId: string, text = "The internal handoff remains blocked.") {
  return {
    eventType: "message_end",
    timestamp: 1,
    data: {
      entryId,
      message: { role: "assistant", content: [{ type: "text", text }] },
    },
  };
}

function makeGatewayWithTranslator(
  sessionManager: ReturnType<typeof createMemorySessionManager>,
  translator: DashboardTranslator,
) {
  return createBrowserGateway(
    sessionManager,
    createMemoryEventStore(() => false),
    makeStubPiGateway(),
    undefined, // pending load manager
    undefined, // pending fork registry
    undefined, // session order manager
    undefined, // preferences store
    undefined, // directory service
    undefined, // terminal manager
    undefined, // pending dashboard spawns
    undefined, // max WS buffer
    undefined, // pending attach registry
    undefined, // pending resume intents
    undefined, // pending client correlations
    undefined, // push prefs
    undefined, // push defaults
    false,     // require browser auth
    undefined, // operator users
    undefined, // operator set
    undefined, // cell access
    translator,
  );
}

describe("dashboard translation at browser egress", () => {
  it("reconnect-order control: subscribe then enable; selected-only; default-off stays silent", async () => {
    const appSource = readFileSync(new URL("../../../client/src/App.tsx", import.meta.url), "utf8");
    const subscribeSource = 'send({ type: "subscribe", sessionId: selectedId, lastSeq: maxSeqMapRef.current.get(selectedId) ?? 0 });';
    const enableSource = 'send({ type: "set_session_translation", sessionId: translationSessionId, enabled: true });';
    const subscribeIndex = appSource.indexOf(subscribeSource);
    const enableIndex = appSource.indexOf(enableSource);
    expect(subscribeIndex).toBeGreaterThanOrEqual(0);
    expect(enableIndex).toBeGreaterThan(subscribeIndex);
    expect(appSource.slice(subscribeIndex, enableIndex)).not.toContain("useEffect(");

    const sessionManager = createMemorySessionManager();
    for (const id of ["default-off", "selected"]) {
      sessionManager.restore({ id, cwd: `/repo/${id}`, source: "tui", status: "active", startedAt: 1, hidden: false } as never);
    }
    const translate = vi.fn(async (request) => ({
      status: "translated" as const,
      entryId: request.entryId,
      sourceHash: `hash-${request.entryId}`,
      text: `plain-${request.entryId}`,
    }));
    const gateway = makeGatewayWithTranslator(sessionManager, { translate });

    const defaultSocket = makeFakeWs();
    gateway.wss.emit("connection", defaultSocket, {});
    defaultSocket.emit("message", Buffer.from(JSON.stringify({ type: "subscribe", sessionId: "default-off" })));
    await new Promise((resolve) => setImmediate(resolve));
    defaultSocket.send.mockClear();
    gateway.broadcastEvent("default-off", 1, assistantEnd("entry-default"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(translate).not.toHaveBeenCalled();
    expect(sentMessages(defaultSocket).filter((message) => message.type === "translation_result")).toHaveLength(0);

    const reconnectSocket = makeFakeWs();
    gateway.wss.emit("connection", reconnectSocket, {});
    reconnectSocket.emit("message", Buffer.from(JSON.stringify({ type: "subscribe", sessionId: "selected" })));
    reconnectSocket.emit("message", Buffer.from(JSON.stringify({ type: "set_session_translation", sessionId: "selected", enabled: true })));
    await new Promise((resolve) => setImmediate(resolve));
    reconnectSocket.send.mockClear();
    gateway.broadcastEvent("default-off", 2, assistantEnd("entry-not-selected"));
    gateway.broadcastEvent("selected", 1, assistantEnd("entry-selected"));
    await new Promise((resolve) => setImmediate(resolve));

    expect(translate).toHaveBeenCalledTimes(1);
    expect(translate.mock.calls[0][0]).toMatchObject({ sessionId: "selected", entryId: "entry-selected" });
    expect(sentMessages(reconnectSocket).filter((message) => message.type === "translation_result")).toHaveLength(1);
  });

  it("sends the original event first, then a separate translation result, without mutating the event", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "pi-translator-egress-"));
    const sessionFile = join(tempDir, "session.jsonl");
    const storedBytes = Buffer.from('{"type":"message","id":"entry-a1","message":{"role":"assistant","content":"The internal handoff remains blocked."}}\n');
    writeFileSync(sessionFile, storedBytes);
    const sessionManager = createMemorySessionManager();
    sessionManager.restore({
      id: "s1",
      cwd: "/repo",
      source: "tui",
      status: "active",
      startedAt: 1,
      hidden: false,
      sessionFile,
    } as never);
    const translator: DashboardTranslator = {
      translate: vi.fn(async (request) => ({
        status: "translated" as const,
        entryId: request.entryId,
        sourceHash: "hash-1",
        text: "The work transfer remains blocked.",
      })),
    };
    const gateway = makeGatewayWithTranslator(sessionManager, translator);
    const ws = makeFakeWs();
    gateway.wss.emit("connection", ws, {});
    ws.emit("message", Buffer.from(JSON.stringify({ type: "subscribe", sessionId: "s1" })));
    ws.emit("message", Buffer.from(JSON.stringify({ type: "set_session_translation", sessionId: "s1", enabled: true })));
    await new Promise((resolve) => setImmediate(resolve));
    ws.send.mockClear();

    const event = assistantEnd("entry-a1");
    const before = JSON.stringify(event);
    gateway.broadcastEvent("s1", 1, event);
    await new Promise((resolve) => setImmediate(resolve));

    const messages = sentMessages(ws);
    expect(messages.map((message) => message.type)).toEqual(["event", "translation_result"]);
    expect(messages[0].event.data.message.content[0].text).toBe("The internal handoff remains blocked.");
    expect(messages[1]).toMatchObject({
      sessionId: "s1",
      entryId: "entry-a1",
      status: "translated",
      text: "The work transfer remains blocked.",
    });
    expect(JSON.stringify(event)).toBe(before);
    expect(readFileSync(sessionFile)).toEqual(storedBytes);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("is OFF by default: zero translator calls and zero translation results", async () => {
    const sessionManager = createMemorySessionManager();
    sessionManager.restore({ id: "s1", cwd: "/repo", source: "tui", status: "active", startedAt: 1, hidden: false } as never);
    const translator: DashboardTranslator = {
      translate: vi.fn(async (request) => ({
        status: "translated" as const,
        entryId: request.entryId,
        sourceHash: "hash",
        text: "Plain English",
      })),
    };
    const gateway = makeGatewayWithTranslator(sessionManager, translator);
    const ws = makeFakeWs();
    gateway.wss.emit("connection", ws, {});
    ws.emit("message", Buffer.from(JSON.stringify({ type: "subscribe", sessionId: "s1" })));
    await new Promise((resolve) => setImmediate(resolve));
    ws.send.mockClear();

    gateway.broadcastEvent("s1", 1, assistantEnd("entry-default"));
    await new Promise((resolve) => setImmediate(resolve));

    expect(translator.translate).not.toHaveBeenCalled();
    expect(sentMessages(ws).map((message) => message.type)).toEqual(["event"]);
  });

  it("allows exactly one enabled session per browser", async () => {
    const sessionManager = createMemorySessionManager();
    for (const id of ["s1", "s2"]) {
      sessionManager.restore({ id, cwd: `/repo/${id}`, source: "tui", status: "active", startedAt: 1, hidden: false } as never);
    }
    const translate = vi.fn(async (request) => ({
      status: "translated" as const,
      entryId: request.entryId,
      sourceHash: `hash-${request.entryId}`,
      text: `plain-${request.entryId}`,
    }));
    const gateway = makeGatewayWithTranslator(sessionManager, { translate });
    const ws = makeFakeWs();
    gateway.wss.emit("connection", ws, {});
    ws.emit("message", Buffer.from(JSON.stringify({ type: "subscribe", sessionId: "s1" })));
    ws.emit("message", Buffer.from(JSON.stringify({ type: "subscribe", sessionId: "s2" })));
    ws.emit("message", Buffer.from(JSON.stringify({ type: "set_session_translation", sessionId: "s1", enabled: true })));
    ws.emit("message", Buffer.from(JSON.stringify({ type: "set_session_translation", sessionId: "s2", enabled: true })));
    await new Promise((resolve) => setImmediate(resolve));
    ws.send.mockClear();

    gateway.broadcastEvent("s1", 1, assistantEnd("entry-s1"));
    gateway.broadcastEvent("s2", 1, assistantEnd("entry-s2"));
    await new Promise((resolve) => setImmediate(resolve));

    expect(translate).toHaveBeenCalledTimes(1);
    expect(translate.mock.calls[0][0]).toMatchObject({ sessionId: "s2", entryId: "entry-s2" });
    expect(sentMessages(ws).filter((message) => message.type === "translation_result")).toHaveLength(1);
  });

  it("does not invoke translation for ask-user or non-assistant events", async () => {
    const translator: DashboardTranslator = { translate: vi.fn() as any };
    const gateway = makeGatewayWithTranslator(createMemorySessionManager(), translator);
    const ws = makeFakeWs();
    gateway.wss.emit("connection", ws, {});

    gateway.sendToClient(ws as any, {
      type: "prompt_request",
      sessionId: "s1",
      promptId: "p1",
      prompt: { question: "Continue?", type: "confirm" },
      component: { type: "generic-dialog", props: {} },
      placement: "inline",
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(translator.translate).not.toHaveBeenCalled();
  });
});
