import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

export type RpcId = string | number;
export interface NdjsonRpcOptions {
  input: Readable;
  output: Writable;
  onNotification?(method: string, params: any): void;
  onRequest?(method: string, params: any, id: RpcId): void | Promise<void>;
  onError?(error: Error): void;
  timeoutMs?: number;
}

export function createNdjsonRpc(options: NdjsonRpcOptions) {
  const decoder = new StringDecoder("utf8");
  const pending = new Map<RpcId, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  let buffered = "";
  let nextId = 1;
  let closed = false;
  const ignoreError = () => {};

  function close(error = new Error("RPC connection closed")) {
    if (closed) return;
    closed = true;
    options.input.off("data", onData);
    options.input.off("end", onEnd);
    options.input.off("error", fail);
    options.output.off("error", fail);
    options.input.on("error", ignoreError);
    options.output.on("error", ignoreError);
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  }

  function fail(error: Error) {
    if (closed) return;
    close(error);
    options.onError?.(error);
  }

  function write(message: unknown) {
    if (closed) throw new Error("RPC connection closed");
    options.output.write(JSON.stringify(message) + "\n");
  }

  function reject(id: RpcId, error: { code: number; message: string }) {
    if (!closed) write({ id, error });
  }

  function frame(line: string) {
    if (!line.trim()) return;
    const message = JSON.parse(line);
    if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("Invalid RPC frame");
    const hasId = typeof message.id === "string" || typeof message.id === "number";
    if (typeof message.method === "string") {
      if (!hasId) {
        options.onNotification?.(message.method, message.params);
        return;
      }
      if (!options.onRequest) {
        reject(message.id, { code: -32601, message: "Unsupported server request" });
        return;
      }
      try {
        Promise.resolve(options.onRequest(message.method, message.params, message.id)).catch(() => {
          reject(message.id, { code: -32603, message: "Server request handler failed" });
        });
      } catch {
        reject(message.id, { code: -32603, message: "Server request handler failed" });
      }
      return;
    }
    if (!hasId) throw new Error("Invalid RPC response");
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(typeof message.error.message === "string" ? message.error.message : "RPC request failed"));
    else if (Object.hasOwn(message, "result")) entry.resolve(message.result);
    else entry.reject(new Error("Invalid RPC response"));
  }

  function onData(chunk: Buffer | string) {
    try {
      buffered += typeof chunk === "string" ? chunk : decoder.write(chunk);
      let end: number;
      while (!closed && (end = buffered.indexOf("\n")) !== -1) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 1);
        frame(line);
      }
      if (Buffer.byteLength(buffered, "utf8") > 32 * 1024 * 1024) throw new Error("RPC frame exceeds 32 MiB");
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  function onEnd() {
    try { frame(buffered + decoder.end()); } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    fail(new Error("RPC connection closed"));
  }

  options.input.on("data", onData);
  options.input.on("end", onEnd);
  options.input.on("error", fail);
  options.output.on("error", fail);

  return {
    request<T = any>(method: string, params: unknown = {}, timeoutMs = options.timeoutMs ?? 30_000): Promise<T> {
      if (closed) return Promise.reject(new Error("RPC connection closed"));
      return new Promise<T>((resolve, rejectPromise) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          rejectPromise(new Error(`RPC timed out: ${method}`));
        }, timeoutMs);
        timer.unref?.();
        pending.set(id, { resolve, reject: rejectPromise, timer });
        try { write({ id, method, params }); } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    notify(method: string, params?: unknown) { write({ method, ...(params === undefined ? {} : { params }) }); },
    reply(id: RpcId, result: unknown) { if (!closed) write({ id, result }); },
    reject,
    close,
  };
}
