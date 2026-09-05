import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCodexRuntimeManager } from "../runtime-manager.js";
import { createMemorySessionManager } from "../../memory-session-manager.js";
import { createMemoryEventStore } from "../../memory-event-store.js";
import { extractSessionUpdates } from "../../event-status-extraction.js";

const processes = vi.hoisted(() => ({ alive: new Set<number>(), isAlive: vi.fn(), kill: vi.fn() }));
vi.mock("@blackbelt-technology/pi-dashboard-shared/platform/process.js", () => ({
  isProcessAlive: processes.isAlive,
  killProcess: processes.kill,
}));

function fakeProcess(pid: number) {
  processes.alive.add(pid);
  return Object.assign(new EventEmitter(), { pid, exitCode: null as number | null, signalCode: null });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { resolve, promise };
}

describe("owned Codex lifecycle", () => {
  let dir: string;
  const managers: ReturnType<typeof createCodexRuntimeManager>[] = [];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codex-manager-"));
    processes.alive.clear();
    processes.isAlive.mockReset().mockImplementation(pid => processes.alive.has(pid));
    processes.kill.mockReset().mockImplementation(async pid => {
      processes.alive.delete(pid);
      return { ok: true, forced: false };
    });
  });
  afterEach(async () => { await Promise.all(managers.splice(0).map(m => m.releaseAll())); rmSync(dir, { recursive: true, force: true }); });

  function setup(factoryOverride?: (opts: any) => Promise<any>) {
    const sessionManager = createMemorySessionManager();
    const eventStore = createMemoryEventStore(() => false);
    const pidRegistry = { register: vi.fn(), linkByPid: vi.fn(() => true), remove: vi.fn() };
    const callbacks: any[] = [];
    const createAdapter = vi.fn(async (opts: any) => {
      callbacks.push(opts);
      if (factoryOverride) return factoryOverride(opts);
      const process = fakeProcess(4000 + callbacks.length);
      opts.onProcess(process);
      opts.onThread({ threadId: opts.threadId ?? "native-thread", threadPath: "/native/session.jsonl", model: "test-model" });
      let streaming = false;
      return {
        runtime: "codex", process, pid: process.pid, threadId: opts.threadId ?? "native-thread", model: "test-model",
        isStreaming: () => streaming,
        send: vi.fn(async (input: any) => { streaming = true; opts.onEvent({ eventType: "agent_start", timestamp: 1, data: {} });
          opts.onEvent({ eventType: "message_start", timestamp: 2, data: { message: { role: "user", content: [{ type: "text", text: input.text }] }, author: input.author } }); }),
        abort: vi.fn(async () => { streaming = false; opts.onEvent({ eventType: "agent_end", timestamp: 3, data: {} }); }),
        dispose: vi.fn(async () => {
          streaming = false;
          process.exitCode = 0;
          processes.alive.delete(process.pid);
          process.emit("exit", 0);
          opts.onExit();
        }),
      };
    });
    const onSessionAdded = vi.fn();
    const onSessionUpdated = vi.fn();
    const manager = createCodexRuntimeManager({ config: { enabled: true }, storageDir: dir, sessionManager, eventStore, pidRegistry: pidRegistry as any,
      createAdapter, onSessionAdded, onSessionUpdated, ingestEvent: (id, event) => {
        eventStore.insertEvent(id, event);
        const updates = extractSessionUpdates(event);
        if (updates) sessionManager.update(id, updates as Partial<import("@blackbelt-technology/pi-dashboard-shared/types.js").DashboardSession>);
      } });
    managers.push(manager);
    return { manager, sessionManager, eventStore, pidRegistry, callbacks, createAdapter, onSessionAdded, onSessionUpdated };
  }

  it("launches a server-stamped session, links PID immediately and correlates browser selection", async () => {
    const h = setup();
    const session = await h.manager.launch({ cwd: dir, requestId: "browser-request", attachProposal: "change" });
    expect(session).toMatchObject({ runtime: "codex", source: "dashboard", codexThreadId: "native-thread", model: "test-model", attachedProposal: "change" });
    expect(session.sessionFile).toBeUndefined();
    expect(h.pidRegistry.register).toHaveBeenCalledWith(4001, dir, expect.anything(), undefined, { runtime: "codex" });
    expect(h.pidRegistry.linkByPid).toHaveBeenCalledWith(session.id, 4001);
    expect(h.onSessionAdded).toHaveBeenCalledWith(session, "browser-request");
    expect(h.pidRegistry.register.mock.invocationCallOrder[0]).toBeLessThan(h.onSessionAdded.mock.invocationCallOrder[0]);
  });
  it("sends multiple turns through one adapter, aborts, restores after restart and resumes the same thread", async () => {
    const h = setup();
    const session = await h.manager.launch({ cwd: dir });
    await h.manager.send(session.id, { text: "remember cedar" });
    await h.manager.abort(session.id);
    await h.manager.send(session.id, { text: "what was the word?" });
    await h.manager.abort(session.id);
    expect(h.createAdapter).toHaveBeenCalledOnce();
    await h.manager.releaseAll();

    const next = setup();
    expect(next.manager.restore()).toHaveLength(1);
    expect(next.createAdapter).not.toHaveBeenCalled();
    expect(next.sessionManager.get(session.id)).toMatchObject({ status: "ended", codexThreadId: "native-thread" });
    next.manager.loadEvents(session.id);
    expect(next.eventStore.getEvents(session.id, 1)).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: expect.objectContaining({ data: expect.objectContaining({
        message: expect.objectContaining({ content: [{ type: "text", text: "remember cedar" }] }),
      }) }) }),
    ]));
    await next.manager.send(session.id, { text: "continue" });
    expect(next.createAdapter).toHaveBeenCalledWith(expect.objectContaining({ threadId: "native-thread" }));
    expect(next.sessionManager.get(session.id)?.endedAt).toBeNull();
    expect(next.sessionManager.get(session.id)?.status).toBe("streaming");
  });
  it("broadcasts ready visibility, availability and current model when a hidden cold session resumes", async () => {
    const first = setup();
    const session = await first.manager.launch({ cwd: dir });
    await first.manager.releaseAll();

    const h = setup();
    h.manager.restore();
    h.sessionManager.update(session.id, { hidden: true, dataUnavailable: true, model: "previous-model" });
    const browserSession = structuredClone(h.sessionManager.get(session.id)!);
    expect(browserSession).toMatchObject({ hidden: true, dataUnavailable: true, status: "ended", model: "previous-model" });
    h.onSessionUpdated.mockImplementation((id, updates) => {
      if (id === session.id) Object.assign(browserSession, JSON.parse(JSON.stringify(updates)));
    });
    await h.manager.attach(session.id);
    expect(h.sessionManager.get(session.id)).toMatchObject({ hidden: false, dataUnavailable: false, status: "idle", endedAt: null, model: "test-model" });
    expect(browserSession).toMatchObject({ hidden: false, dataUnavailable: false, status: "idle", endedAt: null, model: "test-model" });
  });
  it("reloads evicted history and persists token totals without inventing cost", async () => {
    const h = setup();
    const session = await h.manager.launch({ cwd: dir });
    h.callbacks[0].onEvent({ eventType: "stats_update", timestamp: 1, data: { tokensIn: 70, tokensOut: 20, turnUsage: { cacheRead: 30 }, contextUsage: { tokens: 120, contextWindow: 200000 } } });
    expect(h.sessionManager.get(session.id)).toMatchObject({ tokensIn: 70, tokensOut: 20, cacheRead: 30, contextTokens: 120 });
    expect(h.sessionManager.get(session.id)?.cost ?? 0).toBe(0);
    h.eventStore.deleteEventsForSession(session.id);
    h.manager.loadEvents(session.id);
    expect(h.eventStore.getEvents(session.id, 1)).toHaveLength(1);
  });
  it("does not attach pi sessions or launch when disabled", async () => {
    const h = setup();
    h.sessionManager.register({ id: "pi-id", cwd: dir, source: "dashboard" });
    await expect(h.manager.attach("pi-id")).rejects.toThrow();
    expect(h.createAdapter).not.toHaveBeenCalled();
  });
  it("deduplicates concurrent cold attach", async () => {
    const first = setup();
    const session = await first.manager.launch({ cwd: dir });
    await first.manager.releaseAll();
    const h = setup();
    h.manager.restore();
    const [one, two] = await Promise.all([h.manager.attach(session.id), h.manager.attach(session.id)]);
    expect(one).toBe(two);
    expect(h.createAdapter).toHaveBeenCalledOnce();
  });

  it("retains a failed-disposal adapter and PID until a successful retry", async () => {
    const h = setup();
    const session = await h.manager.launch({ cwd: dir });
    const adapter = h.manager.get(session.id)!;
    vi.mocked(adapter.dispose).mockRejectedValueOnce(new Error("child still alive"));
    h.pidRegistry.remove.mockClear();
    await expect(h.manager.release(session.id)).rejects.toThrow(/still alive/);
    expect(h.manager.get(session.id)).toBe(adapter);
    expect(h.pidRegistry.remove).not.toHaveBeenCalled();
    expect(await h.manager.attach(session.id)).toBe(adapter);
    expect(h.createAdapter).toHaveBeenCalledOnce();
    await h.manager.release(session.id);
    expect(h.manager.get(session.id)).toBeUndefined();
    expect(h.pidRegistry.remove).toHaveBeenCalledWith(adapter.pid);
  });

  it("keeps shutdown closed to new launches but retries failed process disposal", async () => {
    const h = setup();
    const session = await h.manager.launch({ cwd: dir });
    const adapter = h.manager.get(session.id)!;
    vi.mocked(adapter.dispose).mockRejectedValueOnce(new Error("child still alive"));
    await expect(h.manager.releaseAll()).rejects.toThrow(/still alive/);
    await expect(h.manager.launch({ cwd: dir })).rejects.toThrow(/closing|stopping/);
    await h.manager.releaseAll();
    expect(adapter.dispose).toHaveBeenCalledTimes(2);
    expect(processes.alive.has(adapter.pid!)).toBe(false);
  });

  it("quarantines a still-live failed attach instead of discarding its PID or starting another child", async () => {
    const proc = fakeProcess(9001);
    const h = setup(async opts => {
      opts.onProcess(proc);
      throw new Error("startup cleanup failed: child alive");
    });
    const session = { id: "codex-failed-attach", runtime: "codex" as const, source: "dashboard" as const, cwd: dir,
      codexThreadId: "native-thread", startedAt: 1, status: "ended" as const };
    h.sessionManager.restore(session);
    await expect(h.manager.attach(session.id)).rejects.toThrow(/cleanup failed/);
    expect(h.pidRegistry.remove).not.toHaveBeenCalled();
    await expect(h.manager.attach(session.id)).rejects.toThrow(/cleanup|closing|alive/);
    expect(h.createAdapter).toHaveBeenCalledOnce();
    await h.manager.release(session.id);
    expect(processes.kill).toHaveBeenCalledWith(proc.pid, expect.any(Object));
    expect(h.pidRegistry.remove).toHaveBeenCalledWith(proc.pid);
  });

  it("clears a failed-start quarantine only after observed process exit", async () => {
    const proc = fakeProcess(9002);
    const h = setup(async opts => { opts.onProcess(proc); throw new Error("startup failed alive"); });
    const session = { id: "codex-exit-cleanup", runtime: "codex" as const, source: "dashboard" as const, cwd: dir,
      codexThreadId: "native-thread", startedAt: 1, status: "ended" as const };
    h.sessionManager.restore(session);
    await expect(h.manager.attach(session.id)).rejects.toThrow();
    expect(h.pidRegistry.remove).not.toHaveBeenCalled();
    proc.exitCode = 0;
    processes.alive.delete(proc.pid);
    h.callbacks[0].onExit();
    expect(h.pidRegistry.remove).toHaveBeenCalledWith(proc.pid);
    h.createAdapter.mockRejectedValueOnce(new Error("second attempt reached factory"));
    await expect(h.manager.attach(session.id)).rejects.toThrow(/second attempt/);
    expect(h.createAdapter).toHaveBeenCalledTimes(2);
  });

  it("retains a child when shutdown races with a failed launch cleanup and retries shutdown", async () => {
    const ready = deferred<any>();
    const proc = fakeProcess(9003);
    const h = setup(async opts => { opts.onProcess(proc); return ready.promise; });
    const launch = h.manager.launch({ cwd: dir });
    const launchRejected = expect(launch).rejects.toThrow();
    await Promise.resolve();
    const stop = h.manager.releaseAll();
    const stopRejected = expect(stop).rejects.toThrow(/alive/);
    const adapter = { process: proc, pid: proc.pid, dispose: vi.fn(async () => { throw new Error("child alive during shutdown"); }) };
    processes.kill.mockResolvedValueOnce({ ok: true, forced: true });
    ready.resolve(adapter);
    await launchRejected;
    await stopRejected;
    expect(h.pidRegistry.remove).not.toHaveBeenCalled();
    await h.manager.releaseAll();
    expect(processes.alive.has(proc.pid)).toBe(false);
    expect(h.pidRegistry.remove).toHaveBeenCalledWith(proc.pid);
  });

  it("does not lose abort while a cold prompt waits for attach", async () => {
    const ready = deferred<any>();
    const proc = fakeProcess(9004);
    let adapter: any;
    const h = setup(async opts => {
      opts.onProcess(proc);
      opts.onThread({ threadId: "native-thread" });
      adapter = { process: proc, pid: proc.pid,
        send: vi.fn(async () => {}), abort: vi.fn(async () => {}),
        dispose: vi.fn(async () => { proc.exitCode = 0; processes.alive.delete(proc.pid); opts.onExit(); }) };
      return ready.promise;
    });
    h.sessionManager.restore({ id: "codex-cold-stop", runtime: "codex", source: "dashboard", cwd: dir,
      codexThreadId: "native-thread", startedAt: 1, status: "ended" });
    const send = h.manager.send("codex-cold-stop", { text: "cancel this cold prompt" });
    const abort = h.manager.abort("codex-cold-stop");
    await Promise.resolve();
    ready.resolve(adapter);
    await Promise.all([send, abort]);
    expect(adapter.send).toHaveBeenCalledOnce();
    expect(adapter.abort).toHaveBeenCalledOnce();
    expect(adapter.send.mock.invocationCallOrder[0]).toBeLessThan(adapter.abort.mock.invocationCallOrder[0]);
  });

  it("preserves failed-start ownership when a pending cold prompt and abort both reject", async () => {
    const ready = deferred<void>();
    const proc = fakeProcess(9005);
    const h = setup(async opts => { opts.onProcess(proc); await ready.promise; throw new Error("attach failed while alive"); });
    h.sessionManager.restore({ id: "codex-rejected-stop", runtime: "codex", source: "dashboard", cwd: dir,
      codexThreadId: "native-thread", startedAt: 1, status: "ended" });
    const sendRejected = expect(h.manager.send("codex-rejected-stop", { text: "pending" })).rejects.toThrow(/attach failed/);
    const abortRejected = expect(h.manager.abort("codex-rejected-stop")).rejects.toThrow(/attach failed/);
    ready.resolve();
    await Promise.all([sendRejected, abortRejected]);
    expect(h.pidRegistry.remove).not.toHaveBeenCalled();
    await h.manager.release("codex-rejected-stop");
    expect(processes.alive.has(proc.pid)).toBe(false);
  });

  it("ignores a delayed exit callback from an already released process after replacement attach", async () => {
    const h = setup();
    const session = await h.manager.launch({ cwd: dir });
    const first = h.manager.get(session.id)!;
    vi.mocked(first.dispose).mockImplementationOnce(async () => {
      Object.assign(first.process, { exitCode: 0 });
      processes.alive.delete(first.pid!);
    });
    await h.manager.release(session.id);
    const next = await h.manager.attach(session.id);
    h.pidRegistry.remove.mockClear();
    h.callbacks[0].onExit();
    expect(h.manager.get(session.id)).toBe(next);
    expect(h.sessionManager.get(session.id)?.status).toBe("idle");
    expect(h.pidRegistry.remove).not.toHaveBeenCalledWith(next.pid);
  });

  it("counts attached idle processes but not historical metadata as activity", async () => {
    const h = setup();
    h.sessionManager.restore({ id: "codex-historical", runtime: "codex", source: "dashboard", cwd: dir,
      codexThreadId: "history", startedAt: 1, status: "ended" });
    expect(h.manager.hasOwnedProcesses()).toBe(false);
    const session = await h.manager.launch({ cwd: dir });
    expect(h.manager.hasOwnedProcesses()).toBe(true);
    await h.manager.release(session.id);
    expect(h.manager.hasOwnedProcesses()).toBe(false);
  });

  it("counts pending attach as activity before an adapter is ready", async () => {
    const ready = deferred<void>();
    const proc = fakeProcess(9006);
    const h = setup(async opts => {
      opts.onProcess(proc);
      await ready.promise;
      opts.onThread({ threadId: "pending-thread" });
      return { process: proc, pid: proc.pid, dispose: vi.fn(async () => {
        proc.exitCode = 0; processes.alive.delete(proc.pid); opts.onExit();
      }) };
    });
    const launch = h.manager.launch({ cwd: dir });
    try {
      expect(h.manager.hasOwnedProcesses()).toBe(true);
    } finally {
      ready.resolve();
      await launch;
    }
  });

  it("counts retained failed-start children until cleanup verifies exit", async () => {
    const proc = fakeProcess(9007);
    const h = setup(async opts => { opts.onProcess(proc); throw new Error("failed alive"); });
    h.sessionManager.restore({ id: "codex-failed-activity", runtime: "codex", source: "dashboard", cwd: dir,
      codexThreadId: "native-thread", startedAt: 1, status: "ended" });
    await expect(h.manager.attach("codex-failed-activity")).rejects.toThrow(/failed alive/);
    expect(h.manager.hasOwnedProcesses()).toBe(true);
    await h.manager.release("codex-failed-activity");
    expect(h.manager.hasOwnedProcesses()).toBe(false);
  });
});
