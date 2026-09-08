import { spawn, type ChildProcess } from "@blackbelt-technology/pi-dashboard-shared/platform/exec.js";
import { isProcessAlive, killProcess } from "@blackbelt-technology/pi-dashboard-shared/platform/process.js";
import { getDefaultRegistry } from "@blackbelt-technology/pi-dashboard-shared/tool-registry/index.js";
import { wrapForSend } from "@blackbelt-technology/pi-dashboard-shared/speaker-wrap.js";
import type { CodexRuntimeConfig } from "@blackbelt-technology/pi-dashboard-shared/config.js";
import type { MessageEnqueuedEventData, QueueStateEventData } from "@blackbelt-technology/pi-dashboard-shared/protocol.js";
import { randomUUID } from "node:crypto";
import { createNdjsonRpc, type RpcId } from "./ndjson-rpc.js";
import { prepareCodexConfig } from "./codex-config.js";
import { createCodexEventMapper } from "./codex-event-mapper.js";
import type { CodexAdapter, RuntimeEvent, RuntimeSendInput } from "./types.js";
export type { CodexAdapter } from "./types.js";

export interface CodexAdapterOptions {
  cwd: string;
  config: CodexRuntimeConfig;
  threadId?: string;
  initialStats?: { tokensIn?: number; tokensOut?: number; cacheRead?: number };
  onProcess(process: ChildProcess): void;
  onThread(info: { threadId: string; threadPath?: string; model?: string }): void;
  onEvent(event: RuntimeEvent): void;
  onSendFailed?(input: RuntimeSendInput, reason: string): void;
  onExit(error?: Error): void;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function bounded<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${operation} timed out`)), timeoutMs);
    timer.unref?.();
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

interface ActiveTurn {
  input: RuntimeSendInput;
  queued: boolean;
  id?: string;
  idReady: ReturnType<typeof deferred<string | undefined>>;
  done: ReturnType<typeof deferred<{ status: string; error?: Error }>>;
  completed: boolean;
  abort?: Promise<void>;
}

export async function createCodexAdapter(options: CodexAdapterOptions): Promise<CodexAdapter> {
  if (!options.config.enabled) throw new Error("Codex runtime is disabled");
  const prepared = prepareCodexConfig(options.config);
  const executable = getDefaultRegistry().resolveExecutor("codex");
  if (!executable.ok || !executable.argv.length) throw new Error("Codex executable not found; configure a codex tool override or install Codex");
  if (/\.(cmd|bat)$/i.test(executable.argv[0])) throw new Error("Codex requires a native executable or Node launcher, not a shell shim");
  const process = spawn(executable.argv[0], [...executable.argv.slice(1), "app-server"], {
    cwd: options.cwd, env: prepared.env, stdio: ["pipe", "pipe", "pipe"], detached: false, shell: false,
  });
  const mapper = createCodexEventMapper({ emit: options.onEvent, initialStats: options.initialStats });
  let threadId = options.threadId ?? "";
  let threadPath: string | undefined;
  let model: string | undefined;
  let active: ActiveTurn | undefined;
  const queue: RuntimeSendInput[] = [];
  let lastCompletedId: string | undefined;
  let closed = false;
  let exited = false;
  let termination: Promise<void> | undefined;
  let stopReason: Error | undefined;
  let rpc: ReturnType<typeof createNdjsonRpc> | undefined;
  let stderr = "";
  const secret = prepared.env[options.config.envKey ?? "OPENAI_API_KEY"];
  const asError = (error: unknown): Error => {
    const text = error instanceof Error ? error.message : String(error);
    return new Error(secret ? text.split(secret).join("[redacted]") : text);
  };

  function queueState(source: QueueStateEventData["source"] = "lifecycle") {
    const data: QueueStateEventData = { followUp: queue.map(input => ({ queueNonce: input.queueNonce, text: input.text,
      source: "dashboard", ...(input.author ? { author: input.author } : {}) })),
      steeringCount: 0, pendingMessageCount: queue.length, source };
    options.onEvent({ eventType: "queue_state", timestamp: Date.now(), data });
  }

  function clearQueue(reason: string) {
    if (!queue.length) return;
    for (const input of queue.splice(0)) {
      options.onSendFailed?.(input, reason);
      options.onEvent({ eventType: "command_feedback", timestamp: Date.now(), data: {
        command: input.text, status: "error", message: reason, queueNonce: input.queueNonce,
      } });
    }
    queueState();
  }

  function drain() {
    if (closed || active || !queue.length) return;
    const input = queue.shift()!;
    void sendTurn(input, true).catch(() => {});
    queueState();
  }

  function finish(error?: Error, status = error ? "failed" : "completed") {
    const turn = active;
    active = undefined;
    if (turn && !turn.completed) {
      turn.completed = true;
      lastCompletedId = turn.id;
      turn.idReady.resolve(undefined);
      turn.done.resolve({ status, error });
    }
    mapper.finishTurn(error?.message);
    if (turn?.queued && error) options.onSendFailed?.(turn.input, error.message);
    queueMicrotask(drain);
  }

  function notifyExit() {
    if (exited) return;
    exited = true;
    options.onExit(stopReason);
  }

  function stop(reason?: Error): Promise<void> {
    if (exited) return Promise.resolve();
    if (termination) return termination;
    closed = true;
    stopReason ??= reason;
    clearQueue(stopReason?.message ?? "Queued message cancelled: session closed");
    try { finish(stopReason); } catch (mappingError) { stopReason ??= asError(mappingError); }
    rpc?.close(stopReason);
    termination = (async () => {
      process.stdin?.end();
      if (process.pid && process.exitCode === null && process.signalCode === null) {
        await killProcess(process.pid, { timeoutMs: 2_000 });
      }
      if (process.pid && isProcessAlive(process.pid)) throw new Error(`Codex app-server process ${process.pid} remains alive after termination`);
      notifyExit();
    })();
    const current = termination;
    void current.finally(() => { if (termination === current) termination = undefined; }).catch(() => {});
    return current;
  }

  function fail(error: unknown) {
    void stop(asError(error)).catch(cleanupError => {
      console.error(`[dashboard] Codex cleanup failed: ${asError(cleanupError).message}`);
    });
  }

  function setTurnId(turn: ActiveTurn, id: unknown) {
    if (typeof id !== "string" || !id) throw new Error("Codex returned no turn id");
    if (turn.id && turn.id !== id) throw new Error("Codex returned inconsistent turn identity");
    if (turn.completed) return;
    turn.id = id;
    turn.idReady.resolve(id);
  }

  function onNotification(method: string, params: any) {
    if (!threadId || params?.threadId !== threadId) return;
    const nativeTurnId = params.turn?.id ?? params.turnId;
    if (method !== "thread/tokenUsage/updated" && nativeTurnId) {
      if (active?.id && nativeTurnId !== active.id) return;
      if (!active?.id && nativeTurnId === lastCompletedId) return;
    }
    if ((method === "turn/started" || method === "turn/completed") && active) setTurnId(active, params.turn?.id);
    // Mapper emits terminal errors synchronously; redact before its first emission.
    const nativeError = method === "error" ? params.error : method === "turn/completed" ? params.turn?.error : undefined;
    if (typeof nativeError?.message === "string") {
      const error = { ...nativeError, message: asError(nativeError.message).message };
      params = method === "error" ? { ...params, error } : { ...params, turn: { ...params.turn, error } };
    }
    mapper.handleNotification(method, params);
    if (method === "turn/completed") {
      const error = params.turn?.status === "failed" ? asError(params.turn.error?.message ?? "Codex turn failed") : undefined;
      finish(error, params.turn?.status ?? "completed");
    } else if (method === "error" && !params.willRetry) {
      finish(asError(params.error?.message ?? "Codex turn failed"));
    }
  }

  function onRequest(method: string, params: any, id: RpcId) {
    let response: unknown;
    switch (method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval": response = { decision: "decline" }; break;
      case "item/permissions/requestApproval": response = { permissions: {}, scope: "turn" }; break;
      case "item/tool/requestUserInput": response = { answers: {} }; break;
      case "mcpServer/elicitation/request": response = { action: "decline", content: null, _meta: null }; break;
      case "item/tool/call": response = { contentItems: [], success: false }; break;
      case "execCommandApproval":
      case "applyPatchApproval": response = { decision: "denied" }; break;
      default: rpc?.reject(id, { code: -32601, message: "Unsupported Codex server request" });
    }
    if (response !== undefined) rpc?.reply(id, response);
    if (!params?.threadId || params.threadId === threadId) {
      try { mapper.requestDeclined(method, id, params); } catch (error) { fail(error); }
    }
  }

  process.on("error", fail);
  process.on("exit", (code, signal) => {
    if (closed) notifyExit();
    else fail(new Error(`Codex app-server exited (${signal ?? code ?? "unknown"})${stderr ? `: ${stderr}` : ""}`));
  });
  process.stderr?.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-2_000); });

  try {
    if (!process.stdin || !process.stdout) throw new Error("Codex app-server requires piped stdin/stdout");
    rpc = createNdjsonRpc({ input: process.stdout, output: process.stdin, onNotification, onRequest, onError: fail });
    options.onProcess(process);
    await rpc.request("initialize", { clientInfo: { name: "pi_dashboard", title: "PI Dashboard", version: "0.5.1" }, capabilities: null });
    rpc.notify("initialized");
    const threadParams = {
      cwd: options.cwd, ...(options.config.model ? { model: options.config.model } : {}),
      modelProvider: prepared.modelProvider, approvalPolicy: "never", sandbox: "workspace-write",
    };
    const result = options.threadId
      ? await rpc.request("thread/resume", { threadId: options.threadId, ...threadParams })
      : await rpc.request("thread/start", { ...threadParams, ephemeral: false });
    if (typeof result?.thread?.id !== "string" || !result.thread.id) throw new Error("Codex returned no thread id");
    if (options.threadId && result.thread.id !== options.threadId) throw new Error("Codex resumed a different thread");
    threadId = result.thread.id;
    threadPath = typeof result.thread.path === "string" ? result.thread.path : undefined;
    model = typeof result.model === "string" ? result.model : options.config.model;
    options.onThread({ threadId, ...(threadPath ? { threadPath } : {}), ...(model ? { model } : {}) });
    if (closed) throw new Error("Codex app-server closed during launch");
  } catch (error) {
    const failure = asError(error);
    await stop(failure);
    throw failure;
  }

  async function sendTurn(input: RuntimeSendInput, queued = false) {
    if (closed) throw new Error("Codex session ended");
    const turn: ActiveTurn = { input, queued, idReady: deferred(), done: deferred(), completed: false };
    active = turn;
    try {
      mapper.beginTurn(input);
      const result = await rpc!.request("turn/start", {
        threadId,
        input: [
          { type: "text", text: wrapForSend(input.text, input.author), text_elements: [] },
          ...(input.images ?? []).map(image => ({ type: "image", url: `data:${image.mimeType};base64,${image.data}` })),
        ],
        ...(options.config.reasoningEffort ? { effort: options.config.reasoningEffort } : {}),
      });
      setTurnId(turn, result?.turn?.id);
    } catch (error) {
      const failure = asError(error);
      await stop(failure);
      throw failure;
    }
  }

  return {
    runtime: "codex", threadId, threadPath, model, process, pid: process.pid,
    isStreaming: () => !!active && !closed,
    async send(input: RuntimeSendInput) {
      if (closed) throw new Error("Codex session ended");
      if (active || queue.length) {
        const queued = { ...input, queueNonce: input.queueNonce ?? randomUUID() };
        queue.push(queued);
        const data: MessageEnqueuedEventData = { ...queued, queueNonce: queued.queueNonce, source: "dashboard" };
        options.onEvent({ eventType: "message_enqueued", timestamp: Date.now(), data });
        queueState("dashboard");
        queueMicrotask(drain);
        return;
      }
      await sendTurn(input);
    },
    abort() {
      clearQueue("Queued message cancelled by Stop");
      const turn = active;
      if (!turn || closed) return Promise.resolve();
      if (turn.abort) return turn.abort;
      turn.abort = (async () => {
        try {
          const id = turn.id ?? await bounded(turn.idReady.promise, 5_000, "Codex turn acceptance");
          if (!id || turn.completed) return;
          await rpc!.request("turn/interrupt", { threadId, turnId: id }, 5_000);
          const outcome = await bounded(turn.done.promise, 5_000, "Codex interrupt completion");
          if (outcome.error) throw outcome.error;
        } catch (error) {
          const failure = asError(error);
          await stop(failure);
          throw failure;
        }
      })();
      return turn.abort;
    },
    dispose: () => stop(),
  };
}
