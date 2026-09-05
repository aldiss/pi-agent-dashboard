import { afterEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { createNdjsonRpc } from "../ndjson-rpc.js";

function fixture(overrides: Record<string, unknown> = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const sent: any[] = [];
  output.on("data", chunk => sent.push(JSON.parse(chunk.toString())));
  const onNotification = vi.fn();
  const onError = vi.fn();
  const rpc = createNdjsonRpc({ input, output, onNotification, onError, ...overrides });
  return { rpc, input, output, sent, onNotification, onError };
}

afterEach(() => vi.useRealTimers());

describe("NDJSON RPC transport", () => {
  it("correlates out-of-order responses around unsolicited notifications", async () => {
    const f = fixture();
    const first = f.rpc.request("initialize", { capabilities: null });
    const second = f.rpc.request("thread/list", {});
    f.input.write(JSON.stringify({ method: "remoteControl/status/changed", params: { status: "off" } }) + "\n");
    f.input.write(JSON.stringify({ id: f.sent[1].id, result: { threads: [] } }) + "\n");
    f.input.write(JSON.stringify({ id: f.sent[0].id, result: { userAgent: "fixture" } }) + "\n");
    expect(await first).toEqual({ userAgent: "fixture" });
    expect(await second).toEqual({ threads: [] });
    expect(f.onNotification).toHaveBeenCalledWith("remoteControl/status/changed", { status: "off" });
    f.rpc.close();
  });

  it("buffers partial lines and split UTF-8 characters without corruption", () => {
    const f = fixture();
    const payload = Buffer.from(JSON.stringify({ method: "delta", params: { text: "hello 🌍 café" } }) + "\n");
    for (const byte of payload) f.input.write(Buffer.from([byte]));
    expect(f.onNotification).toHaveBeenCalledWith("delta", { text: "hello 🌍 café" });
    f.rpc.close();
  });

  it("answers requests by their envelope id and preserves notification framing", async () => {
    let rpc: ReturnType<typeof createNdjsonRpc>;
    const f = fixture({ onRequest: (method: string, _params: unknown, id: string | number) => rpc.reply(id, { method }) });
    rpc = f.rpc;
    f.input.write('{"id":"approval-1","method":"approve","params":{"approvalId":"different"}}\n');
    await Promise.resolve();
    expect(f.sent).toContainEqual({ id: "approval-1", result: { method: "approve" } });
    f.rpc.notify("initialized");
    expect(f.sent.at(-1)).toEqual({ method: "initialized" });
    f.rpc.close();
  });

  it("rejects unhandled or throwing request handlers instead of leaving requests pending", async () => {
    const missing = fixture();
    missing.input.write('{"id":0,"method":"unknown","params":{}}\n');
    await Promise.resolve();
    expect(missing.sent[0]).toMatchObject({ id: 0, error: { code: -32601 } });
    missing.rpc.close();
    const throwing = fixture({ onRequest: () => { throw new Error("handler failed"); } });
    throwing.input.write('{"id":12,"method":"known","params":{}}\n');
    await Promise.resolve();
    expect(throwing.sent[0]).toMatchObject({ id: 12, error: { code: -32603 } });
    throwing.rpc.close();
  });

  it("times out requests and ignores late responses", async () => {
    vi.useFakeTimers();
    const f = fixture({ timeoutMs: 10 });
    const pending = f.rpc.request("slow", {});
    const rejected = expect(pending).rejects.toThrow(/timed out.*slow/);
    await vi.advanceTimersByTimeAsync(11);
    await rejected;
    f.input.write(JSON.stringify({ id: f.sent[0].id, result: "late" }) + "\n");
    expect(f.onError).not.toHaveBeenCalled();
    f.rpc.close();
  });

  it.each(["end", "error", "malformed"])("rejects pending requests on %s", async failure => {
    const f = fixture();
    const pending = f.rpc.request("pending", {});
    const rejected = expect(pending).rejects.toThrow();
    if (failure === "end") f.input.end();
    else if (failure === "error") f.output.emit("error", new Error("broken pipe"));
    else f.input.write("not-json\n");
    await rejected;
    expect(f.onError).toHaveBeenCalledOnce();
    await expect(f.rpc.request("after-close", {})).rejects.toThrow(/closed/i);
  });
});
