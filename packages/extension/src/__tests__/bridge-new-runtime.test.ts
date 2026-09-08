import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionManagerOptions } from "../connection.js";
import bridge from "../bridge.js";
import * as sessionSync from "../session-sync.js";

const transport = vi.hoisted(() => ({
  receive: undefined as ConnectionManagerOptions["onMessage"],
  send: vi.fn(),
  disconnect: vi.fn(),
  pauseAutoStart: vi.fn(),
}));

vi.mock("../connection.js", () => ({
  ConnectionManager: class {
    constructor(options: ConnectionManagerOptions) { transport.receive = options.onMessage; }
    send = transport.send;
    disconnect = transport.disconnect;
    pauseAutoStart = transport.pauseAutoStart;
  },
}));
vi.mock("@blackbelt-technology/pi-dashboard-shared/config.js", async (original) => ({
  ...await original<typeof import("@blackbelt-technology/pi-dashboard-shared/config.js")>(),
  ensureConfig: vi.fn(),
  loadConfig: () => ({ piPort: 9999, devBuildOnReload: false }),
}));
vi.mock("../provider-register.js", () => ({
  activate: vi.fn(),
  onProviderChanged: vi.fn(),
  reloadProviders: vi.fn(),
  buildProviderCatalogue: vi.fn(() => []),
}));

const BRIDGE_KEY = "__pi_dashboard_bridge__";
const notify = vi.fn();
const on = vi.fn();
let previousState: unknown;

beforeEach(() => {
  vi.clearAllMocks();
  previousState = (process as any)[BRIDGE_KEY];
  (process as any)[BRIDGE_KEY] = { sessionId: "native-session", ctx: { ui: { notify } } };
  transport.receive = undefined;
  bridge({ on, registerCommand: vi.fn() } as never);
  expect(transport.receive).toBeTypeOf("function");
});

async function nativeInput(text: string, source = "interactive") {
  for (const [eventType, handler] of on.mock.calls) {
    if (eventType !== "input") continue;
    const result = await handler({ type: "input", text, source }, { ui: { notify } });
    if (result?.action === "handled") return result;
  }
}

describe("native pi input routes before model inference", () => {
  it.each(["interactive", "rpc", "extension"])("consumes /new codex from %s and sends a spawn request", async (source) => {
    expect(await nativeInput("/new codex", source)).toEqual({ action: "handled" });
    expect(transport.send).toHaveBeenCalledWith({
      type: "spawn_new_session", sessionId: "native-session", cwd: process.cwd(), runtime: "codex",
    });
    expect(transport.send.mock.calls.filter(([frame]) => frame.type === "spawn_new_session")).toHaveLength(1);
  });

  it.each(["/new", "/new pi"])("retains the pi runtime for %s when delivered as input", async (text) => {
    expect(await nativeInput(text)).toEqual({ action: "handled" });
    expect(transport.send).toHaveBeenCalledWith({
      type: "spawn_new_session", sessionId: "native-session", cwd: process.cwd(),
    });
  });

  it("consumes invalid runtime input with visible feedback rather than sending it to the model", async () => {
    expect(await nativeInput("/new bogus")).toEqual({ action: "handled" });
    expect(transport.send.mock.calls.some(([frame]) => frame.type === "spawn_new_session")).toBe(false);
    expect(transport.send).toHaveBeenCalledWith(expect.objectContaining({
      type: "event_forward", event: expect.objectContaining({
        eventType: "command_feedback", data: expect.objectContaining({ status: "error" }),
      }),
    }));
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("bogus"), "error");
  });

  it.each(["ordinary task", "/model provider/model", "/newer"])("does not intercept %s", async (text) => {
    expect(await nativeInput(text)).toBeUndefined();
    expect(transport.send.mock.calls.some(([frame]) => frame.type === "spawn_new_session")).toBe(false);
  });

  it("consumes a failed spawn instead of falling through to the model", async () => {
    transport.send.mockImplementationOnce(() => { throw new Error("Test transport failure"); });
    expect(await nativeInput("/new codex")).toEqual({ action: "handled" });
    expect(notify).toHaveBeenCalledWith("Test transport failure", "error");
  });
});

describe("bridge ownership across native pi session replacement", () => {
  it("rebinds cached context before synchronizing the replacement session", async () => {
    (process as any)[BRIDGE_KEY].pi.registerTool = vi.fn();
    const replacement = { hasUI: true, ui: { notify }, sessionManager: { getSessionId: () => "replacement-session" } };
    const start = on.mock.calls.find(([eventType]) => eventType === "session_start")![1];
    const sync = vi.spyOn(sessionSync, "handleSessionChange").mockImplementation(() => { throw new Error("End sync boundary probe"); });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await start({ reason: "new" }, replacement);
      expect(sync).toHaveBeenCalledWith(expect.objectContaining({ cachedCtx: replacement, cachedHasUI: true }), replacement, expect.any(Function));
    } finally {
      sync.mockRestore();
      errors.mockRestore();
    }
  });

  it("refuses another pi instance while the parent bridge remains active", () => {
    const owner = (process as any)[BRIDGE_KEY].pi;
    const otherOn = vi.fn();
    bridge({ on: otherOn, registerCommand: vi.fn() } as never);
    expect(otherOn).not.toHaveBeenCalled();
    expect((process as any)[BRIDGE_KEY].pi).toBe(owner);
    expect(transport.disconnect).not.toHaveBeenCalled();
  });

  it("releases the old owner on shutdown so bare /new can attach its replacement", async () => {
    const generation = (process as any)[BRIDGE_KEY].generation;
    const shutdown = on.mock.calls.find(([eventType]) => eventType === "session_shutdown")![1];
    await shutdown();
    const replacementOn = vi.fn();
    const replacement = { on: replacementOn, registerCommand: vi.fn() };
    bridge(replacement as never);

    expect(replacementOn.mock.calls.some(([eventType]) => eventType === "input")).toBe(true);
    expect((process as any)[BRIDGE_KEY].pi).toBe(replacement);
    expect((process as any)[BRIDGE_KEY].generation).toBeGreaterThan(generation);

    transport.send.mockClear();
    expect(await nativeInput("/new codex")).toBeUndefined();
    expect(transport.send).not.toHaveBeenCalled();
    await shutdown();
    expect((process as any)[BRIDGE_KEY].pi).toBe(replacement);
  });
});

afterEach(() => {
  (process as any)[BRIDGE_KEY]?.cleanup?.();
  if (previousState === undefined) delete (process as any)[BRIDGE_KEY];
  else (process as any)[BRIDGE_KEY] = previousState;
});

describe("bridge forwards the requested runtime", () => {
  it("ACCEPTANCE 4 — a bare /new frame is unchanged (no runtime key)", async () => {
    await transport.receive!({ type: "send_prompt", sessionId: "native-session", text: "/new" });

    expect(transport.send).toHaveBeenCalledWith({
      type: "spawn_new_session", sessionId: "native-session", cwd: process.cwd(),
    });
  });

  it("an explicit /new pi is also unchanged on the wire", async () => {
    await transport.receive!({ type: "send_prompt", sessionId: "native-session", text: "/new pi" });

    expect(transport.send).toHaveBeenCalledWith({
      type: "spawn_new_session", sessionId: "native-session", cwd: process.cwd(),
    });
  });

  it("ACCEPTANCE 2 (bridge half) — /new codex carries runtime:\"codex\"", async () => {
    await transport.receive!({ type: "send_prompt", sessionId: "native-session", text: "/new codex" });

    expect(transport.send).toHaveBeenCalledWith({
      type: "spawn_new_session", sessionId: "native-session", cwd: process.cwd(), runtime: "codex",
    });
  });

  it("ACCEPTANCE 5 — an unknown runtime sends no spawn frame at all", async () => {
    await transport.receive!({ type: "send_prompt", sessionId: "native-session", text: "/new bogus" });

    const spawnFrames = transport.send.mock.calls
      .map(([frame]) => frame)
      .filter((frame) => (frame as { type?: string })?.type === "spawn_new_session");
    expect(spawnFrames).toEqual([]);
  });
});
