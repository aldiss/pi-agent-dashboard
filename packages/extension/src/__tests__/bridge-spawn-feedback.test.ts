import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionManagerOptions } from "../connection.js";
import bridge from "../bridge.js";

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
let previousState: unknown;

beforeEach(() => {
  vi.clearAllMocks();
  previousState = (process as any)[BRIDGE_KEY];
  (process as any)[BRIDGE_KEY] = { sessionId: "native-session", ctx: { ui: { notify } } };
  transport.receive = undefined;
  bridge({ on: vi.fn(), registerCommand: vi.fn() } as any);
  expect(transport.receive).toBeTypeOf("function");
});

afterEach(() => {
  (process as any)[BRIDGE_KEY]?.cleanup?.();
  if (previousState === undefined) delete (process as any)[BRIDGE_KEY];
  else (process as any)[BRIDGE_KEY] = previousState;
});

describe("bridge spawn result feedback", () => {
  it("positive control: dispatches existing restart notifications through the real bridge", async () => {
    await transport.receive!({ type: "server_restarting", reason: "restart", quiesceMs: 1000 });
    expect(transport.pauseAutoStart).toHaveBeenCalledWith(1000);
  });

  it("shows a refused /new result through the cached native UI without changing the sender", async () => {
    await transport.receive!({ type: "send_prompt", sessionId: "native-session", text: "/new" });
    expect(transport.send).toHaveBeenCalledWith({ type: "spawn_new_session", sessionId: "native-session", cwd: process.cwd() });
    transport.send.mockClear();

    await transport.receive!({ type: "spawn_result", cwd: process.cwd(), success: false, message: "Spawn refused: delegation-refused" });
    expect(notify).toHaveBeenCalledExactlyOnceWith("Spawn refused: delegation-refused", "error");
    expect(transport.send).not.toHaveBeenCalled();
  });

  it("surfaces process launch failures through the same notification path", async () => {
    await transport.receive!({ type: "spawn_result", cwd: "/project", success: false, message: "Unable to start session" });
    expect(notify).toHaveBeenCalledExactlyOnceWith("Unable to start session", "error");
  });

  it("keeps successful spawn replies silent", async () => {
    await transport.receive!({ type: "spawn_result", cwd: "/project", success: true, message: "Session started" });
    expect(notify).not.toHaveBeenCalled();
    expect(transport.send).not.toHaveBeenCalled();
  });
});
