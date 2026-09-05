import { randomUUID } from "node:crypto";
import type { ChildProcess } from "@blackbelt-technology/pi-dashboard-shared/platform/exec.js";
import { isProcessAlive, killProcess } from "@blackbelt-technology/pi-dashboard-shared/platform/process.js";
import type { CodexRuntimeConfig } from "@blackbelt-technology/pi-dashboard-shared/config.js";
import type { DashboardEvent, DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import type { SessionManager } from "../memory-session-manager.js";
import type { EventStore } from "../memory-event-store.js";
import type { HeadlessPidRegistry } from "../headless-pid-registry.js";
import { extractStatsFromEvents } from "../event-status-extraction.js";
import { createCodexAdapter } from "./codex-adapter.js";
import { createCodexSessionStore } from "./codex-session-store.js";
import type { CodexAdapter, RuntimeSendInput } from "./types.js";

export interface CodexRuntimeManagerOptions {
  config: CodexRuntimeConfig;
  storageDir?: string;
  sessionManager: SessionManager;
  eventStore: EventStore;
  pidRegistry: HeadlessPidRegistry;
  ingestEvent(sessionId: string, event: DashboardEvent): void;
  onSessionAdded(session: DashboardSession, requestId?: string): void;
  onSessionUpdated(sessionId: string, updates: Partial<DashboardSession>): void;
  createAdapter?: typeof createCodexAdapter;
}

export type CodexRuntimeManager = ReturnType<typeof createCodexRuntimeManager>;

export function createCodexRuntimeManager(options: CodexRuntimeManagerOptions) {
  const { sessionManager, eventStore, pidRegistry } = options;
  const config = { ...options.config };
  const store = createCodexSessionStore(options.storageDir);
  const adapters = new Map<string, CodexAdapter>();
  const pending = new Map<string, Promise<CodexAdapter>>();
  const releasing = new Map<string, Promise<void>>();
  const failedStarts = new Map<string, ChildProcess>();
  let stopping = false;
  let stopped = false;
  let shutdown: Promise<void> | undefined;
  const factory = options.createAdapter ?? createCodexAdapter;

  function running(process: ChildProcess | undefined): boolean {
    return !!process?.pid && process.exitCode == null && process.signalCode == null && isProcessAlive(process.pid);
  }

  function update(id: string, changes: Partial<DashboardSession>) {
    sessionManager.update(id, changes);
    const session = sessionManager.get(id);
    if (session?.codexThreadId) store.save(session);
    options.onSessionUpdated(id, changes);
  }

  function end(id: string) {
    update(id, { status: "ended", endedAt: Date.now(), pid: undefined, currentTool: null, resuming: false });
  }

  function loadEvents(id: string) {
    if (eventStore.hasEvents(id)) return;
    const session = sessionManager.get(id);
    if (session?.runtime !== "codex") return;
    const events = store.readEvents(id, !adapters.has(id) && session.status === "ended");
    for (const event of events) eventStore.insertEvent(id, event);
    // Journal stats are authoritative if a crash interrupted the debounced metadata write.
    const stats = extractStatsFromEvents(events);
    if (stats) sessionManager.update(id, stats);
  }

  function recordEvent(id: string, event: DashboardEvent) {
    try {
      store.append(id, event);
      options.ingestEvent(id, event);
      if (event.eventType === "stats_update") {
        const current = sessionManager.get(id);
        const data = event.data as {
          tokensIn?: number; tokensOut?: number; turnUsage?: { cacheRead?: number };
          contextUsage?: { tokens?: number | null; contextWindow?: number };
        };
        update(id, { tokensIn: (current?.tokensIn ?? 0) + (data.tokensIn ?? 0),
          tokensOut: (current?.tokensOut ?? 0) + (data.tokensOut ?? 0),
          cacheRead: (current?.cacheRead ?? 0) + (data.turnUsage?.cacheRead ?? 0),
          ...(data.contextUsage ? { contextTokens: data.contextUsage.tokens, contextWindow: data.contextUsage.contextWindow } : {}) });
      }
      const current = sessionManager.get(id);
      if (current) store.save(current);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[codex] event persistence failed: ${message}`);
      options.ingestEvent(id, { eventType: "agent_end", timestamp: Date.now(), data: { messages: [{ stopReason: "error", errorMessage: message }] } });
      void release(id).catch(() => {});
    }
  }

  function create(session: DashboardSession): Promise<CodexAdapter> {
    if (!config.enabled) return Promise.reject(new Error("Codex runtime is not enabled"));
    if (stopping || releasing.has(session.id)) return Promise.reject(new Error("Codex session is closing"));
    if (failedStarts.has(session.id)) return Promise.reject(new Error("Codex process remains alive; cleanup required before attach"));
    const existing = adapters.get(session.id);
    if (existing) return Promise.resolve(existing);
    const attaching = pending.get(session.id);
    if (attaching) return attaching;
    let process: ChildProcess | undefined;
    let processExited = false;
    const operation: Promise<CodexAdapter> = Promise.resolve().then(() => factory({
      cwd: session.cwd, config, threadId: session.codexThreadId,
      initialStats: { tokensIn: session.tokensIn, tokensOut: session.tokensOut, cacheRead: session.cacheRead },
      onProcess(proc) {
        process = proc;
        if (proc.pid) {
          pidRegistry.register(proc.pid, session.cwd, proc, undefined, { runtime: "codex" });
          pidRegistry.linkByPid(session.id, proc.pid);
        }
      },
      onThread(info) {
        if (session.codexThreadId && session.codexThreadId !== info.threadId) throw new Error("Codex resumed a different thread");
        const current = sessionManager.get(session.id) ?? session;
        const ready: DashboardSession = { ...current, runtime: "codex", codexThreadId: info.threadId,
          codexThreadPath: info.threadPath, model: info.model ?? current.model, status: "idle", endedAt: null,
          pid: process?.pid, resuming: false, hidden: false, dataUnavailable: false };
        // Native identity reaches disk before any launch/attach acknowledgement.
        store.save(ready, true);
        sessionManager.restore(ready);
      },
      onEvent(event) {
        recordEvent(session.id, event);
      },
      onExit() {
        processExited = true;
        const ownsSession = pending.get(session.id) === operation
          || (process !== undefined && adapters.get(session.id)?.process === process)
          || (process !== undefined && failedStarts.get(session.id) === process);
        if (!ownsSession) return;
        if (process?.pid) pidRegistry.remove(process.pid);
        if (failedStarts.get(session.id) === process) failedStarts.delete(session.id);
        if (stopping || releasing.has(session.id)) return;
        adapters.delete(session.id);
        if (sessionManager.get(session.id)) end(session.id);
      },
    })).then(async adapter => {
      if (stopping) { await adapter.dispose(); throw new Error("Dashboard is stopping"); }
      if (processExited) throw new Error("Codex process exited during startup");
      adapters.set(session.id, adapter);
      // restore() is silent; publish ready visibility and model metadata too.
      update(session.id, { ...sessionManager.get(session.id), status: "idle", endedAt: null, resuming: false, pid: adapter.pid });
      return adapter;
    }).catch(err => {
      if (!processExited && running(process)) {
        failedStarts.set(session.id, process!);
      } else {
        if (process?.pid) pidRegistry.remove(process.pid);
        if (sessionManager.get(session.id)) end(session.id);
      }
      throw err;
    }).finally(() => { if (pending.get(session.id) === operation) pending.delete(session.id); });
    pending.set(session.id, operation);
    return operation;
  }

  function attach(id: string) {
    const session = sessionManager.get(id);
    if (session?.runtime !== "codex" || !session.codexThreadId) return Promise.reject(new Error("Codex session not found"));
    loadEvents(id);
    return create(session);
  }

  function release(id: string): Promise<void> {
    const existing = releasing.get(id);
    if (existing) return existing;
    const operation = Promise.resolve().then(async () => {
      let adapter = adapters.get(id);
      if (!adapter && pending.has(id)) {
        try { adapter = await pending.get(id); } catch { /* Failed attach may leave a quarantined process below. */ }
      }
      const failedProcess = failedStarts.get(id);
      if (adapter) {
        await adapter.dispose();
        if (running(adapter.process)) throw new Error("Codex process remains alive after disposal");
        adapters.delete(id);
        if (adapter.pid) pidRegistry.remove(adapter.pid);
      }
      if (failedProcess) {
        if (running(failedProcess)) await killProcess(failedProcess.pid!, { timeoutMs: 2_000 });
        if (running(failedProcess)) throw new Error("Codex failed-start process remains alive after cleanup");
        failedStarts.delete(id);
        if (failedProcess.pid && failedProcess.pid !== adapter?.pid) pidRegistry.remove(failedProcess.pid);
      }
      if (sessionManager.get(id)?.runtime === "codex") end(id);
      store.flush();
    }).finally(() => releasing.delete(id));
    releasing.set(id, operation);
    return operation;
  }

  return {
    get(id: string) { return adapters.get(id); },
    hasOwnedProcesses() { return adapters.size > 0 || pending.size > 0 || failedStarts.size > 0; },
    restore() {
      const sessions = store.list();
      for (const session of sessions) sessionManager.restore(session);
      return sessions;
    },
    persist(session: DashboardSession) { if (session.runtime === "codex" && session.codexThreadId) store.save(session); },
    loadEvents,
    feedback(id: string, command: string, message: string) {
      if (sessionManager.get(id)?.runtime === "codex") recordEvent(id, { eventType: "command_feedback", timestamp: Date.now(), data: { command, status: "error", message } });
    },
    async launch(input: { cwd: string; requestId?: string; attachProposal?: string }) {
      const session: DashboardSession = { id: `codex-${randomUUID()}`, runtime: "codex", source: "dashboard", cwd: input.cwd,
        status: "active", startedAt: Date.now(), ...(input.attachProposal ? { attachedProposal: input.attachProposal, name: input.attachProposal } : {}) };
      await create(session);
      const ready = sessionManager.get(session.id)!;
      options.onSessionAdded(ready, input.requestId);
      return ready;
    },
    attach,
    async send(id: string, input: RuntimeSendInput) {
      const adapter = await attach(id);
      const session = sessionManager.get(id)!;
      if (!session.firstMessage) update(id, { firstMessage: input.text.slice(0, 500) });
      await adapter.send(input);
    },
    async abort(id: string) {
      const adapter = adapters.get(id) ?? await pending.get(id);
      await adapter?.abort();
    },
    release,
    releaseAll(): Promise<void> {
      if (stopped) return Promise.resolve();
      if (shutdown) return shutdown;
      stopping = true;
      const operation = (async () => {
        await Promise.allSettled([...pending.values()]);
        const ids = new Set([...adapters.keys(), ...failedStarts.keys()]);
        const outcomes = await Promise.allSettled([...ids].map(release));
        const failed = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
        if (failed) throw failed.reason;
        store.dispose();
        stopped = true;
      })();
      shutdown = operation.finally(() => { shutdown = undefined; });
      return shutdown;
    },
  };
}
