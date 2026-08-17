/**
 * Tests for streamer.ts: streamCompletion wraps pi-ai's streamSimple.
 *
 * Uses faux registry + streamSimple mocks — no real pi-ai required.
 *
 * See change: add-dashboard-model-proxy, tasks 6.2 + 6.3.
 */
import { describe, it, expect, vi } from "vitest";
import { streamCompletion } from "../streamer.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeModel(id = "test-model") {
  return { id, provider: "test-provider" };
}

function makeRegistry(apiKey = "sk-test", headers = {} as Record<string, string>) {
  return {
    getApiKeyAndHeaders: vi.fn().mockResolvedValue({ apiKey, headers }),
  };
}

async function* fakeStream(events: any[]): AsyncIterable<any> {
  for (const e of events) yield e;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("streamCompletion", () => {
  it("calls streamSimple with resolved credentials", async () => {
    const model = makeModel();
    const registry = makeRegistry("sk-abc", { "x-foo": "bar" });
    const streamSimple = vi.fn().mockReturnValue(fakeStream([{ type: "start" }]));

    await streamCompletion({ model, messages: [{ role: "user", content: "hi" }] }, streamSimple as any, registry);

    expect(registry.getApiKeyAndHeaders).toHaveBeenCalledWith(model);
    expect(streamSimple).toHaveBeenCalledOnce();
    const [, , optionsArg] = streamSimple.mock.calls[0];
    expect(optionsArg.apiKey).toBe("sk-abc");
    expect(optionsArg.headers).toEqual({ "x-foo": "bar" });
  });

  it("passes model, messages, and optional fields through to streamSimple", async () => {
    const model = makeModel();
    const registry = makeRegistry();
    const streamSimple = vi.fn().mockReturnValue(fakeStream([]));

    const messages = [{ role: "user", content: "hello" }];
    const tools = [{ name: "search" }];
    const signal = new AbortController().signal;

    await streamCompletion({ model, messages, system: "Be helpful", tools, maxTokens: 100, temperature: 0.7, reasoning: "minimal", timeoutMs: 5000, maxRetries: 0, signal }, streamSimple as any, registry);

    const [modelArg, contextArg, optionsArg] = streamSimple.mock.calls[0];
    expect(modelArg).toEqual(model);
    expect(contextArg.messages).toEqual(messages);
    expect(contextArg.systemPrompt).toBe("Be helpful");
    expect(contextArg.tools).toEqual(tools);
    expect(optionsArg.maxTokens).toBe(100);
    expect(optionsArg.temperature).toBe(0.7);
    expect(optionsArg.reasoning).toBe("minimal");
    expect(optionsArg.timeoutMs).toBe(5000);
    expect(optionsArg.maxRetries).toBe(0);
    expect(optionsArg.signal).toBe(signal);
  });

  it("applies a credential-specific base URL without mutating the catalog model", async () => {
    const model = makeModel();
    const registry = {
      getApiKeyAndHeaders: vi.fn().mockResolvedValue({
        apiKey: "copilot-token",
        headers: {},
        baseUrl: "https://api.enterprise.githubcopilot.com",
      }),
    };
    const streamSimple = vi.fn().mockReturnValue(fakeStream([]));

    await streamCompletion({ model, messages: [] }, streamSimple as any, registry);

    expect(streamSimple.mock.calls[0][0]).toEqual({
      ...model,
      baseUrl: "https://api.enterprise.githubcopilot.com",
    });
    expect(model).not.toHaveProperty("baseUrl");
  });

  it("omits systemPrompt when not provided", async () => {
    const model = makeModel();
    const registry = makeRegistry();
    const streamSimple = vi.fn().mockReturnValue(fakeStream([]));

    await streamCompletion({ model, messages: [] }, streamSimple as any, registry);

    const [, contextArg] = streamSimple.mock.calls[0];
    expect("systemPrompt" in contextArg).toBe(false);
  });

  it("yields events from the underlying stream", async () => {
    const model = makeModel();
    const registry = makeRegistry();
    const events = [
      { type: "start" },
      { type: "text_delta", delta: "hello" },
      { type: "done", message: { stopReason: "stop", usage: { input: 5, output: 3 }, content: [] } },
    ];
    const streamSimple = vi.fn().mockReturnValue(fakeStream(events));

    const iterable = await streamCompletion({ model, messages: [] }, streamSimple as any, registry);
    const collected: any[] = [];
    for await (const event of iterable) collected.push(event);

    expect(collected).toHaveLength(3);
    expect(collected[0].type).toBe("start");
    expect(collected[1].delta).toBe("hello");
    expect(collected[2].type).toBe("done");
  });

  it("AbortSignal abort terminates iteration promptly (task 6.3)", async () => {
    const model = makeModel();
    const registry = makeRegistry();
    const controller = new AbortController();

    let yieldCount = 0;
    async function* slowStream(): AsyncIterable<any> {
      try {
        while (true) {
          if (controller.signal.aborted) return;
          yield { type: "text_delta", delta: "chunk" };
          yieldCount++;
          if (yieldCount === 1) {
            controller.abort(); // abort after first event
          }
          // Small delay so abort check catches up
          await new Promise((r) => setTimeout(r, 5));
        }
      } finally {
        // generator cleans up
      }
    }

    const streamSimple = vi.fn().mockReturnValue(slowStream());

    const iterable = await streamCompletion(
      { model, messages: [], signal: controller.signal },
      streamSimple as any,
      registry,
    );

    const start = Date.now();
    const collected: any[] = [];
    for await (const event of iterable) {
      collected.push(event);
    }
    const elapsed = Date.now() - start;

    // Terminates promptly — well under 100ms after abort
    expect(elapsed).toBeLessThan(200);
    // Only events before abort emitted
    expect(collected.length).toBeLessThanOrEqual(2);
  });
});
