/**
 * Model proxy route handlers: /v1/models, /v1/chat/completions, /v1/messages.
 *
 * OpenAI- and Anthropic-compatible endpoints fronting the dashboard's
 * model registry via pi-ai's streamSimple.
 *
 * See change: add-dashboard-model-proxy.
 */
import crypto from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { ModelProxyConfig } from "@blackbelt-technology/pi-dashboard-shared/config.js";
import {
  convertOpenAIMessages,
  convertOpenAITools,
  eventToSSEChunks,
  eventToNonStreamingResponse,
  ToolCallIndexTracker,
  convertAnthropicMessages,
  convertAnthropicTools,
  eventToAnthropicSSE,
  eventToAnthropicResponse,
  AnthropicBlockTracker,
} from "../model-proxy/convert/index.js";
import { ConcurrencyTracker, ConcurrencyError } from "../model-proxy/concurrency.js";
import { logRequest, type RequestLogEntry } from "../model-proxy/request-log.js";

export interface ModelProxyRouteDeps {
  getConfig: () => ModelProxyConfig;
  /** Resolve the model registry. Returns null when pi-ai is unavailable. */
  getRegistry: () => Promise<ModelProxyRegistry | null>;
}

/** Minimal interface for the model registry consumed by route handlers. */
export interface ModelProxyRegistry {
  getAvailable(): Promise<any[]>;
  find(provider: string, modelId: string): Promise<any | null>;
  getApiKeyAndHeaders(model: any): Promise<{ apiKey: string; headers: Record<string, string>; baseUrl?: string }>;
}

/** Minimal interface for pi-ai's streamSimple. */
export type StreamSimpleFn = (opts: any) => AsyncIterable<any>;

const concurrency = new ConcurrencyTracker();

export function registerModelProxyRoutes(
  fastify: FastifyInstance,
  deps: ModelProxyRouteDeps & { streamSimple?: StreamSimpleFn },
): void {
  const { getConfig, getRegistry } = deps;

  // ── GET /v1/models ──────────────────────────────────────────────────
  fastify.get("/v1/models", async (request, reply) => {
    const registry = await getRegistry();
    if (!registry) {
      return reply.code(503).send({
        code: "MODEL_PROXY_RUNTIME_MISSING",
        message: "pi-ai is not installed or cannot be resolved",
      });
    }

    const models = await registry.getAvailable();
    const data = models.map((m: any) => ({
      id: `${m.provider}/${m.id}`,
      object: "model" as const,
      created: Math.floor(Date.now() / 1000),
      owned_by: m.provider,
      "x-pi": {
        ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
        ...(m.maxTokens ? { maxTokens: m.maxTokens } : {}),
        ...(m.reasoning != null ? { reasoning: m.reasoning } : {}),
        ...(m.cost ? { cost: m.cost } : {}),
        ...(m.input ? { input: m.input } : {}),
      },
    }));

    return { object: "list", data };
  });

  // ── POST /v1/chat/completions ───────────────────────────────────────
  fastify.post("/v1/chat/completions", {
    config: { compress: false },
  }, async (request, reply) => {
    const body = request.body as any;
    if (!body?.messages) {
      return reply.code(400).send({ error: { message: "messages is required", type: "invalid_request_error" } });
    }

    const config = getConfig();
    const modelId = body.model || config.defaultModel;
    if (!modelId) {
      return reply.code(400).send({ error: { message: "model is required", type: "invalid_request_error" } });
    }

    const registry = await getRegistry();
    if (!registry) {
      return reply.code(503).send({ code: "MODEL_PROXY_RUNTIME_MISSING", message: "pi-ai unavailable" });
    }

    const stream = body.stream === true;
    const apiKeyId = (request as any).proxyApiKeyId;
    const [provider] = modelId.includes("/") ? modelId.split("/", 2) : ["unknown", modelId];

    // Acquire concurrency
    let release: (() => void) | undefined;
    try {
      release = concurrency.acquire({ apiKeyId, provider }, config);
    } catch (e) {
      if (e instanceof ConcurrencyError) {
        const status = e.code === "SERVER_FULL" ? 503 : 429;
        reply.header("Retry-After", String(Math.ceil(e.retryAfterMs / 1000)));
        return reply.code(status).send({ code: e.code });
      }
      throw e;
    }

    const startTime = Date.now();
    const requestId = crypto.randomUUID();
    const msgId = crypto.randomUUID().slice(0, 8);

    try {
      const { systemPrompt, messages } = convertOpenAIMessages(body.messages);
      const tools = body.tools ? convertOpenAITools(body.tools) : undefined;

      // Resolve model
      const [prov, mid] = modelId.includes("/") ? modelId.split("/", 2) : [undefined, modelId];
      const model = prov ? await registry.find(prov, mid) : null;
      if (!model) {
        return reply.code(404).send({ error: { message: `Model not found: ${modelId}`, type: "invalid_request_error" } });
      }

      const creds = await registry.getApiKeyAndHeaders(model);
      const requestModel = creds.baseUrl ? { ...model, baseUrl: creds.baseUrl } : model;
      const controller = new AbortController();

      // Abort on client disconnect
      request.raw.on("close", () => controller.abort());

      const streamSimple = deps.streamSimple;
      if (!streamSimple) {
        return reply.code(503).send({ code: "MODEL_PROXY_RUNTIME_MISSING", message: "streamSimple unavailable" });
      }

      const streamOpts: any = {
        model: requestModel,
        messages,
        ...(systemPrompt ? { system: systemPrompt } : {}),
        ...(tools ? { tools } : {}),
        ...(body.max_tokens != null ? { maxTokens: body.max_tokens } : {}),
        ...(body.temperature != null ? { temperature: body.temperature } : {}),
        signal: controller.signal,
        apiKey: creds.apiKey,
        headers: creds.headers,
      };

      const eventStream = streamSimple(streamOpts);

      if (stream) {
        // Streaming SSE response
        if (typeof request.raw.setTimeout === "function") request.raw.setTimeout(0);
        reply.raw.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        });

        const tracker = new ToolCallIndexTracker();
        let lastMsg: any;

        for await (const event of eventStream) {
          if (event.type === "done") lastMsg = event.message;
          const sseChunks = eventToSSEChunks(event, modelId, msgId, tracker);
          for (const chunk of sseChunks) {
            reply.raw.write(chunk);
          }
        }

        reply.raw.end();
        maybeLog(config, { ts: new Date().toISOString(), requestId, apiKeyId, model: modelId, format: "openai", status: 200, durationMs: Date.now() - startTime, inputTokens: lastMsg?.usage?.input, outputTokens: lastMsg?.usage?.output });
      } else {
        // Non-streaming response
        let finalMsg: any;
        for await (const event of eventStream) {
          if (event.type === "done") finalMsg = event.message;
          if (event.type === "error") {
            maybeLog(config, { ts: new Date().toISOString(), requestId, apiKeyId, model: modelId, format: "openai", status: 500, durationMs: Date.now() - startTime, error: event.error?.errorMessage });
            return reply.code(500).send({ error: { message: event.error?.errorMessage || "Provider error", type: "api_error" } });
          }
        }

        if (!finalMsg) {
          return reply.code(500).send({ error: { message: "No response from model", type: "api_error" } });
        }

        const response = eventToNonStreamingResponse(finalMsg, modelId, msgId);
        maybeLog(config, { ts: new Date().toISOString(), requestId, apiKeyId, model: modelId, format: "openai", status: 200, durationMs: Date.now() - startTime, inputTokens: finalMsg.usage?.input, outputTokens: finalMsg.usage?.output });
        return response;
      }
    } catch (err: any) {
      if (err.name === "AbortError") return; // Client disconnected
      maybeLog(config, { ts: new Date().toISOString(), requestId, apiKeyId, model: modelId, format: "openai", status: 500, durationMs: Date.now() - startTime, error: err.message });
      return reply.code(500).send({ error: { message: err.message || "Internal error", type: "api_error" } });
    } finally {
      release?.();
    }
  });

  // ── POST /v1/messages ───────────────────────────────────────────────
  fastify.post("/v1/messages", {
    config: { compress: false },
  }, async (request, reply) => {
    const body = request.body as any;
    if (!body?.messages || !body?.max_tokens) {
      return reply.code(400).send({ error: { type: "invalid_request_error", message: "messages and max_tokens are required" } });
    }

    const config = getConfig();
    const modelId = body.model || config.defaultModel;
    if (!modelId) {
      return reply.code(400).send({ error: { type: "invalid_request_error", message: "model is required" } });
    }

    const registry = await getRegistry();
    if (!registry) {
      return reply.code(503).send({ code: "MODEL_PROXY_RUNTIME_MISSING", message: "pi-ai unavailable" });
    }

    const stream = body.stream === true;
    const apiKeyId = (request as any).proxyApiKeyId;
    const [provider] = modelId.includes("/") ? modelId.split("/", 2) : ["unknown", modelId];

    let release: (() => void) | undefined;
    try {
      release = concurrency.acquire({ apiKeyId, provider }, config);
    } catch (e) {
      if (e instanceof ConcurrencyError) {
        const status = e.code === "SERVER_FULL" ? 503 : 429;
        reply.header("Retry-After", String(Math.ceil(e.retryAfterMs / 1000)));
        return reply.code(status).send({ code: e.code });
      }
      throw e;
    }

    const startTime = Date.now();
    const requestId = crypto.randomUUID();
    const msgId = `msg_${crypto.randomUUID().slice(0, 12)}`;

    try {
      const { systemPrompt, messages } = convertAnthropicMessages(body);
      const tools = body.tools ? convertAnthropicTools(body.tools) : undefined;

      const [prov, mid] = modelId.includes("/") ? modelId.split("/", 2) : [undefined, modelId];
      const model = prov ? await registry.find(prov, mid) : null;
      if (!model) {
        return reply.code(404).send({ error: { type: "invalid_request_error", message: `Model not found: ${modelId}` } });
      }

      const creds = await registry.getApiKeyAndHeaders(model);
      const requestModel = creds.baseUrl ? { ...model, baseUrl: creds.baseUrl } : model;
      const controller = new AbortController();
      request.raw.on("close", () => controller.abort());

      const streamSimple = deps.streamSimple;
      if (!streamSimple) {
        return reply.code(503).send({ code: "MODEL_PROXY_RUNTIME_MISSING", message: "streamSimple unavailable" });
      }

      const streamOpts: any = {
        model: requestModel,
        messages,
        ...(systemPrompt ? { system: systemPrompt } : {}),
        ...(tools ? { tools } : {}),
        maxTokens: body.max_tokens,
        ...(body.temperature != null ? { temperature: body.temperature } : {}),
        signal: controller.signal,
        apiKey: creds.apiKey,
        headers: creds.headers,
      };

      const eventStream = streamSimple(streamOpts);

      if (stream) {
        if (typeof request.raw.setTimeout === "function") request.raw.setTimeout(0);
        reply.raw.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        });

        const tracker = new AnthropicBlockTracker();
        let lastMsg: any;

        for await (const event of eventStream) {
          if (event.type === "done") lastMsg = event.message;
          const sseChunks = eventToAnthropicSSE(event, modelId, msgId, tracker);
          for (const chunk of sseChunks) {
            reply.raw.write(chunk);
          }
        }

        reply.raw.end();
        maybeLog(config, { ts: new Date().toISOString(), requestId, apiKeyId, model: modelId, format: "anthropic", status: 200, durationMs: Date.now() - startTime, inputTokens: lastMsg?.usage?.input, outputTokens: lastMsg?.usage?.output });
      } else {
        let finalMsg: any;
        for await (const event of eventStream) {
          if (event.type === "done") finalMsg = event.message;
          if (event.type === "error") {
            maybeLog(config, { ts: new Date().toISOString(), requestId, apiKeyId, model: modelId, format: "anthropic", status: 500, durationMs: Date.now() - startTime, error: event.error?.errorMessage });
            return reply.code(500).send({ error: { type: "api_error", message: event.error?.errorMessage || "Provider error" } });
          }
        }

        if (!finalMsg) {
          return reply.code(500).send({ error: { type: "api_error", message: "No response from model" } });
        }

        const response = eventToAnthropicResponse(finalMsg, modelId, msgId);
        maybeLog(config, { ts: new Date().toISOString(), requestId, apiKeyId, model: modelId, format: "anthropic", status: 200, durationMs: Date.now() - startTime, inputTokens: finalMsg.usage?.input, outputTokens: finalMsg.usage?.output });
        return response;
      }
    } catch (err: any) {
      if (err.name === "AbortError") return;
      maybeLog(config, { ts: new Date().toISOString(), requestId, apiKeyId, model: modelId, format: "anthropic", status: 500, durationMs: Date.now() - startTime, error: err.message });
      return reply.code(500).send({ error: { type: "api_error", message: err.message || "Internal error" } });
    } finally {
      release?.();
    }
  });
}

function maybeLog(config: ModelProxyConfig, entry: RequestLogEntry): void {
  if (config.logRequests) logRequest(entry);
}
