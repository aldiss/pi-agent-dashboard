import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionManagerOptions } from "../connection.js";
import bridge from "../bridge.js";

/**
 * Wire-level check: `/new codex` typed by an AGENT inside a real pi session
 * reaches the server as `spawn_new_session { runtime: "codex" }`, and a bare
 * `/new` stays byte-identical to its pre-existing frame (no `runtime` key).
 *
 * Mirrors the harness in `bridge-spawn-feedback.test.ts` — the real bridge,
 * only the transport faked.
 */

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
  bridge({ on: vi.fn(), registerCommand: vi.fn() } as never);
  expect(transport.receive).toBeTypeOf("function");
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
