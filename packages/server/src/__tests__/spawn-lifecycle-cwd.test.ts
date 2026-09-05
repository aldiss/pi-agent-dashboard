import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { createMemorySessionManager } from "../memory-session-manager.js";
import { createSpawnGate } from "../spawn-boundary.js";
import { registerSessionApi } from "../session-api.js";
import { handleResumeSession, handleSendPrompt } from "../browser-handlers/session-action-handler.js";
import { spawnPiSession, setResolver, resetResolver } from "../process-manager.js";
import { execSync } from "@blackbelt-technology/pi-dashboard-shared/platform/exec.js";
import { spawnDetached } from "@blackbelt-technology/pi-dashboard-shared/platform/detached-spawn.js";
import { killProcess } from "@blackbelt-technology/pi-dashboard-shared/platform/process.js";
import { resolveDriverLiveness } from "../driver-liveness.js";
import { createSpawnTestContext } from "../test-support/spawn-policy-fixture.js";

vi.mock("../process-manager.js", async (original) => {
  const actual = await original<typeof import("../process-manager.js")>();
  return { ...actual, spawnPiSession: vi.fn(actual.spawnPiSession) };
});
vi.mock("@blackbelt-technology/pi-dashboard-shared/platform/exec.js", async (original) => ({
  ...await original<typeof import("@blackbelt-technology/pi-dashboard-shared/platform/exec.js")>(),
  execSync: vi.fn(() => Buffer.from("")), spawnSync: vi.fn(() => ({ status: 0 })),
}));
vi.mock("@blackbelt-technology/pi-dashboard-shared/platform/detached-spawn.js", async (original) => ({
  ...await original<typeof import("@blackbelt-technology/pi-dashboard-shared/platform/detached-spawn.js")>(),
  spawnDetached: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@blackbelt-technology/pi-dashboard-shared/platform/process.js", async (original) => ({
  ...await original<typeof import("@blackbelt-technology/pi-dashboard-shared/platform/process.js")>(),
  killProcess: vi.fn(), isProcessAlive: vi.fn(() => false),
}));
vi.mock("../driver-liveness.js", async (original) => ({
  ...await original<typeof import("../driver-liveness.js")>(), resolveDriverLiveness: vi.fn(),
}));
vi.mock("@blackbelt-technology/pi-dashboard-shared/config.js", async (original) => ({
  ...await original<typeof import("@blackbelt-technology/pi-dashboard-shared/config.js")>(),
  loadConfig: () => ({ spawnStrategy: "headless" }),
}));

let dir: string;
let root: string;
let outside: string;
let alias: string;
beforeEach(() => {
  vi.clearAllMocks();
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "spawn-lifecycle-cwd-")));
  root = path.join(dir, "root"); outside = path.join(dir, "outside"); alias = path.join(dir, "alias");
  fs.mkdirSync(root); fs.mkdirSync(outside); fs.symlinkSync(root, alias, "dir");
  fs.writeFileSync(path.join(root, "session.jsonl"), "");
  setResolver({ which: () => "/mock/tool", resolvePi: () => ["/mock/pi"], buildSpawnEnv: (env: unknown) => env } as never);
  vi.mocked(resolveDriverLiveness).mockReturnValue({ alive: false });
  vi.mocked(killProcess).mockResolvedValue({ ok: true, forced: false });
});
afterEach(() => {
  resetResolver();
  fs.rmSync(dir, { recursive: true, force: true });
});

function context(requireBrowserAuth: boolean) {
  const identity = createSpawnTestContext({ requireBrowserAuth });
  const sessionManager = createMemorySessionManager();
  sessionManager.register({ id: "session", source: "tui", cwd: alias, sessionFile: path.join(root, "session.jsonl") });
  sessionManager.update("session", { status: "ended" });
  const spawnGate = createSpawnGate({
    requireBrowserAuth, operatorUsers: identity.operatorUsers, localBridgeOperator: null,
    expectedBridgeToken: null, requireBridgeToken: false, trustedNetworks: [], enabledRuntimes: ["pi"],
    getPermittedRoots: () => [root], getAllowedOrigins: () => [],
  });
  return {
    ...identity, spawnGate, sessionManager, ws: {} as any,
    piGateway: { isSessionConnected: () => false, sendToSession: vi.fn(() => true), address: () => null },
    headlessPidRegistry: { getPid: () => 12345, killBySessionId: vi.fn(), register: vi.fn() },
    eventStore: { insertEvent: vi.fn(() => 1) }, broadcast: vi.fn(), sendTo: vi.fn(),
    pendingResumeRegistry: { record: vi.fn(), consume: vi.fn() }, pendingResumeIntents: { record: vi.fn() },
    pendingDashboardSpawns: new Map(), pendingAttachRegistry: { enqueue: vi.fn() },
  } as any;
}

function expectScopedSpawn() {
  expect(spawnPiSession).toHaveBeenCalledExactlyOnceWith(root, expect.any(Object), { permittedRoots: [root] });
}

describe.each([false, true])("lifecycle cwd policy requireBrowserAuth=%s", (requireBrowserAuth) => {
  it.each(["continue", "fork", "fork-empty", "auto-resume", "reload"])("browser %s carries canonical cwd and roots", async (action) => {
    const ctx = context(requireBrowserAuth);
    if (action === "fork-empty") fs.unlinkSync(path.join(root, "session.jsonl"));
    if (action === "reload") ctx.sessionManager.update("session", { status: "idle" });
    if (action === "auto-resume" || action === "reload") {
      await handleSendPrompt({ type: "send_prompt", sessionId: "session", text: action === "reload" ? "/reload" : "continue" }, ctx);
    } else {
      await handleResumeSession({ type: "resume_session", sessionId: "session", mode: action === "continue" ? "continue" : "fork" }, ctx);
    }
    expectScopedSpawn();
  });

  async function rest(action: string, swap?: "alias" | "root") {
    const ctx = context(requireBrowserAuth);
    if (action === "fork-empty") fs.unlinkSync(path.join(root, "session.jsonl"));
    if (swap) {
      vi.mocked(resolveDriverLiveness).mockReturnValue({ alive: true, pid: 12345 });
      vi.mocked(killProcess).mockImplementation(async () => {
        await Promise.resolve();
        const target = swap === "alias" ? alias : root;
        fs.rmSync(target, { recursive: true });
        fs.symlinkSync(outside, target, "dir");
        return { ok: true, forced: false };
      });
    }
    const app = Fastify();
    app.addHook("onRequest", async (request) => { (request as any).restPrincipal = ctx.principal; });
    registerSessionApi(app, {
      ...ctx, browserGateway: { headlessPidRegistry: ctx.headlessPidRegistry, broadcastSessionUpdated: vi.fn() },
      resurrectVerify: async () => ({ ok: true, retried: false, attempts: 1 }),
    });
    try {
      return await app.inject({ method: "POST", url: `/api/session/session/${action === "resurrect" ? action : "resume"}`,
        payload: { mode: action === "continue" ? "continue" : "fork" } });
    } finally {
      await app.close();
    }
  }

  it.each(["continue", "fork", "fork-empty", "resurrect"])("REST %s carries canonical cwd and roots", async (action) => {
    const response = await rest(action);
    expect(response.statusCode).toBe(200);
    expectScopedSpawn();
  });

  it("REST takeover never re-resolves a session alias after the awaited kill", async () => {
    const response = await rest("resurrect", "alias");
    expect(response.statusCode).toBe(200);
    expect(killProcess).toHaveBeenCalledOnce();
    expectScopedSpawn();
    expect((await vi.mocked(spawnPiSession).mock.results[0].value).cwd).toBe(root);
  });

  it("REST takeover refuses a replaced canonical directory before any new process effect", async () => {
    const response = await rest("resurrect", "root");
    expect(killProcess).toHaveBeenCalledOnce();
    expect(response.statusCode).toBe(500);
    expect(response.json().error).toContain("Spawn cwd is not permitted");
    expect(execSync).not.toHaveBeenCalled();
    expect(spawnDetached).not.toHaveBeenCalled();
  });
});
