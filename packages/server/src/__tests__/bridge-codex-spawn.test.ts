import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { wireEvents, type EventWiringDeps } from "../event-wiring.js";
import { createSpawnGate } from "../spawn-boundary.js";
import type { ExtensionToServerMessage } from "@blackbelt-technology/pi-dashboard-shared/protocol.js";
import type { BridgeConnectionContext } from "../pi-gateway.js";
import type { SessionRuntime } from "@blackbelt-technology/pi-dashboard-shared/types.js";

/**
 * Bridge-ingress codex spawn (`/new codex` from an AGENT inside a pi session).
 *
 * Exercises the REAL `createSpawnGate` — not a permissive stub — so the
 * authorization posture under test is the shipped one. Only the executors
 * (`spawnPiSession`, `runtimeManager.launch`) are stubbed, because the
 * assertion is about WHICH executor the bridge path reaches, and with what
 * runtime claim.
 */

const BRIDGE_TOKEN = "c".repeat(64);
const OPERATOR = "aldiss";
// The gate realpath-resolves the requested cwd, so the fixture root must exist
// on disk — otherwise every case would die on `cwd-not-permitted` and the
// runtime assertions would never be reached.
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-codex-spawn-")));
const CWD = path.join(ROOT, "project");
fs.mkdirSync(CWD, { recursive: true });

vi.mock("../process-manager.js", () => ({
  spawnPiSession: vi.fn(async () => ({ success: true, message: "pi session started" })),
}));
const { spawnPiSession } = await import("../process-manager.js");

vi.mock("@blackbelt-technology/pi-dashboard-shared/config.js", async (original) => ({
  ...await original<typeof import("@blackbelt-technology/pi-dashboard-shared/config.js")>(),
  loadConfig: () => ({ spawnStrategy: "tmux" }),
}));

function harness(options: { enabledRuntimes?: SessionRuntime[]; withRuntimeManager?: boolean } = {}) {
  const spawnGate = createSpawnGate({
    requireBrowserAuth: true,
    operatorUsers: [OPERATOR],
    localBridgeOperator: OPERATOR,
    expectedBridgeToken: BRIDGE_TOKEN,
    requireBridgeToken: true,
    trustedNetworks: [],
    enabledRuntimes: options.enabledRuntimes ?? ["pi", "codex"],
    getPermittedRoots: () => [ROOT],
    getAllowedOrigins: () => [],
  });

  const launch = vi.fn(async () => ({ id: "codex-1", pid: 4242 }));
  const sent: unknown[] = [];
  const broadcast: unknown[] = [];

  let onEvent: ((s: string, m: ExtensionToServerMessage, c: BridgeConnectionContext) => void) | undefined;
  const deps = {
    spawnGate,
    getRuntimeManager: () => (options.withRuntimeManager === false ? undefined : { launch } as never),
    sessionManager: { get: () => undefined, update: vi.fn(), register: vi.fn(), listActive: () => [], listAll: () => [] },
    eventStore: { insertEvent: vi.fn(() => 1), getEvents: () => [] },
    piGateway: { set onEvent(fn: never) { onEvent = fn as never; }, get onEvent() { return onEvent as never; } },
    browserGateway: {
      sendToSubscribers: vi.fn(),
      broadcastToAll: vi.fn((m: unknown) => { broadcast.push(m); }),
      broadcastSessionUpdated: vi.fn(),
      broadcastSessionAdded: vi.fn(),
      headlessPidRegistry: { register: vi.fn() },
      viewedSessionTracker: undefined,
    },
    sessionOrderManager: { insert: vi.fn(), getOrder: () => [], moveToFront: vi.fn() },
    pendingForkRegistry: { consume: () => undefined },
    directoryService: {},
    knownSessionIds: new Set<string>(),
    pendingDashboardSpawns: new Map<string, number>(),
  } as unknown as EventWiringDeps;

  wireEvents(deps);

  const connection = (over: Partial<BridgeConnectionContext> = {}): BridgeConnectionContext => ({
    remoteAddress: "127.0.0.1", origin: null, forwarded: false,
    presentedBridgeToken: BRIDGE_TOKEN, trusted: true,
    send: (reply) => { sent.push(reply); return true; },
    ...over,
  });

  const spawn = async (msg: Record<string, unknown>, over?: Partial<BridgeConnectionContext>) => {
    onEvent!("pi-session-1", { type: "spawn_new_session", sessionId: "pi-session-1", cwd: CWD, ...msg } as never, connection(over));
    await new Promise((r) => setTimeout(r, 10));
  };

  return { spawn, launch, sent, broadcast };
}

const lastResult = (sent: unknown[]) => sent.filter((m): m is { type: string; success: boolean; message: string } =>
  (m as { type?: string }).type === "spawn_result").at(-1);

describe("bridge-ingress spawn: runtime selection", () => {
  beforeEach(() => {
    // `spawnPiSession` is a module-scoped mock shared by every case; without
    // this the `not.toHaveBeenCalled()` assertions would inherit earlier calls.
    vi.mocked(spawnPiSession).mockClear();
  });

  it("ACCEPTANCE 2 — delegated loopback bridge spawns codex through the runtime manager", async () => {
    const { spawn, launch, sent } = harness();
    await spawn({ runtime: "codex" });

    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0][0]).toMatchObject({ cwd: CWD });
    expect(spawnPiSession).not.toHaveBeenCalled();
    expect(lastResult(sent)).toMatchObject({ success: true });
  });

  it("ACCEPTANCE 1 — codex is denied `runtime-not-enabled` when config disables it", async () => {
    const { spawn, launch, sent } = harness({ enabledRuntimes: ["pi"] });
    await spawn({ runtime: "codex" });

    expect(launch).not.toHaveBeenCalled();
    expect(spawnPiSession).not.toHaveBeenCalled();
    expect(lastResult(sent)).toMatchObject({ success: false, message: "Spawn refused: runtime-not-enabled" });
  });

  it("ACCEPTANCE 4 — a runtime-less spawn still routes to pi, untouched", async () => {
    const { spawn, launch, sent } = harness();
    await spawn({});

    expect(spawnPiSession).toHaveBeenCalledTimes(1);
    expect(launch).not.toHaveBeenCalled();
    expect(lastResult(sent)).toMatchObject({ success: true });
  });

  it("ACCEPTANCE 5 — an unknown runtime never reaches the codex executor", async () => {
    const { spawn, launch } = harness();
    // A wire-level forgery bypassing the bridge-side grammar refusal: the
    // server must not treat an unrecognized token as codex.
    await spawn({ runtime: "bogus" });

    expect(launch).not.toHaveBeenCalled();
    expect(spawnPiSession).toHaveBeenCalledTimes(1);
  });

  it("refuses codex when the runtime manager is unavailable — never downgrades to pi", async () => {
    const { spawn, sent } = harness({ withRuntimeManager: false });
    await spawn({ runtime: "codex" });

    expect(spawnPiSession).not.toHaveBeenCalled();
    expect(lastResult(sent)).toMatchObject({ success: false, message: "Codex runtime is unavailable" });
  });

  it("keeps the bridge-token / loopback conditions binding for codex", async () => {
    // A failed bridge-token check collapses delegation, so the composed gate
    // refuses at the BASE session-action layer (`operator-only`) before
    // `authorizeSpawn` reports `untrusted-bridge`. Either way the codex
    // executor is never reached — that is the property under test.
    const wrongToken = harness();
    await wrongToken.spawn({ runtime: "codex" }, { presentedBridgeToken: "d".repeat(64) });
    expect(wrongToken.launch).not.toHaveBeenCalled();
    expect(lastResult(wrongToken.sent)).toMatchObject({ success: false });

    const remote = harness();
    await remote.spawn({ runtime: "codex" }, { remoteAddress: "10.1.2.3" });
    expect(remote.launch).not.toHaveBeenCalled();
    expect(lastResult(remote.sent)).toMatchObject({ success: false });

    const forwarded = harness();
    await forwarded.spawn({ runtime: "codex" }, { forwarded: true });
    expect(forwarded.launch).not.toHaveBeenCalled();
    expect(lastResult(forwarded.sent)).toMatchObject({ success: false });
  });

  it("keeps cwd containment binding for codex", async () => {
    const { spawn, launch, sent } = harness();
    await spawn({ runtime: "codex", cwd: "/etc" });

    expect(launch).not.toHaveBeenCalled();
    expect(lastResult(sent)).toMatchObject({ success: false, message: "Spawn refused: cwd-not-permitted" });
  });
});
