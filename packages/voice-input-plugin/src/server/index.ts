/**
 * voice-input-plugin server registrar.
 *
 * Mounts:
 *   POST /api/plugins/voice-input/transcribe   — accept audio blob, proxy to sidecar
 *   GET  /api/plugins/voice-input/health       — surface sidecar reachability
 *
 * Architecture: HTTP-proxy-to-sidecar. The sidecar is a separate process
 * (`pi-voice-sidecar` from the `~/Copilot/pi-extensions/voice-input/` Python
 * MODULE) that hosts the actual whisper/parakeet inference. This plugin
 * does NOT spawn the sidecar; it expects an already-running sidecar reachable
 * at `state.cfg.sidecarUrl` and proxies requests over loopback HTTP. The
 * dashboard server's launcher OR an external supervisor (launchd / systemd)
 * owns sidecar lifecycle.
 *
 * Per-request `connectionTimeout` adjustment (CalmRaven 2026-05-13 patch):
 * the dashboard's Fastify instance is constructed with
 * `connectionTimeout: 10_000`, which drops the socket if no activity in 10s.
 * Voice transcription takes ~20-25s typical on iMac (per voice-input
 * substrate r1 § W3.5 § 8); without raising the per-request value, the
 * dashboard would close the proxy connection long before the sidecar
 * returns, and clients would see "Empty reply from server". We raise it
 * here per-route to match the explicit AbortController budget.
 *
 * Engine default per operator empirical 2026-05-17 ~12:30 CEST verbatim
 * Russian: "а в чем проблема с паракитом? он отлично по-русски распознает"
 * ("what's the problem with parakeet? it recognizes Russian fine") —
 * Pattern 87 preserved. FastUnion's earlier r17 diagnosis that
 * `parakeet-tdt-0.6b-v3` is English-only was empirically wrong; defaults
 * stay `engine: "parakeet"` for ~5s typical latency on Apple Silicon.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { TelemetrySink, type SanitizedRecord } from "./telemetry-sink.js";

/** Correlation-id header, shared across client → dashboard → sidecar. */
const REQUEST_ID_HEADER = "x-voice-request-id";

interface PluginConfig {
  /** URL of the running voice-input sidecar. Defaults to `http://127.0.0.1:8765`. */
  sidecarUrl: string;
  /** Per-request timeout budget for transcribe forwarding (ms). */
  requestTimeoutMs: number;
  /** Default engine when the client doesn't specify. */
  engine: "parakeet" | "whisper";
}

const DEFAULTS: PluginConfig = {
  sidecarUrl: "http://127.0.0.1:8765",
  // r17-REVERTED per operator empirical 2026-05-17 ~12:30 CEST: operator verbatim Russian
  // "а в чем проблема с паракитом? он отлично по-русски распознает" (= "what's the problem with parakeet?
  // it recognizes Russian fine"). FastUnion's r17 diagnosis "parakeet-tdt-0.6b-v3 is English-only" was
  // WRONG per operator's direct empirical experience. Defaults.engine stays parakeet to preserve
  // operator's ~5s baseline; the actual desktop transcribe bug (long hourglass + wrong text)
  // needs different root cause investigation (audio-format / model-variant / config-drift hypothesis).
  engine: "parakeet",
  // r16 BUGFIX (FastUnion 2026-05-16 ~14 CEST per operator iPhone empirical):
  // "so now i have the sandclock for more than two minutes" — sidecar parakeet warmup repeatedly
  // fails (mlx-community/parakeet-tdt-0.6b-v3 load NoneType error), falls back to whisper which
  // takes ~25-50s typical + sometimes longer for >30s audio clips. 60s budget combined with
  // warmup-window race left no headroom; transcribe aborted, client never got response.
  // 120s gives whisper-fallback ~2x typical envelope; composes with PushToTalkButton inline-error
  // display (substrate r11) which surfaces actual error to operator on timeout/abort.
  requestTimeoutMs: 120_000,
};

interface PluginState {
  cfg: PluginConfig;
  sidecarHealthy: boolean;
}

async function probeSidecar(state: PluginState): Promise<void> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    const res = await fetch(`${state.cfg.sidecarUrl}/health`, {
      method: "GET",
      signal: controller.signal,
    });
    clearTimeout(timer);
    state.sidecarHealthy = res.ok;
  } catch {
    state.sidecarHealthy = false;
  }
}

/**
 * Resolve the correlation id for a request. Prefer the client-supplied
 * `X-Voice-Request-Id` (so all three layers share ONE id); if absent, mint a
 * random one and flag `client_id_absent` — itself a diagnostic signal that the
 * client-side layer did not run or could not set the header. The id is random
 * and carries no audio/transcript content.
 */
function resolveRequestId(request: FastifyRequest): { id: string; clientAbsent: boolean } {
  const raw = request.headers[REQUEST_ID_HEADER];
  const supplied = Array.isArray(raw) ? raw[0] : raw;
  if (typeof supplied === "string" && supplied.length > 0) {
    return { id: supplied.slice(0, 128), clientAbsent: false };
  }
  const g = globalThis as unknown as { crypto?: { randomUUID?: () => string } };
  const id = g.crypto?.randomUUID ? g.crypto.randomUUID() : `srv-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
  return { id, clientAbsent: true };
}

export async function register(
  fastify: FastifyInstance,
  opts: Partial<PluginConfig> = {}
): Promise<void> {
  const state: PluginState = {
    cfg: { ...DEFAULTS, ...opts },
    sidecarHealthy: false,
  };

  // Telemetry sink (Layer 2). Logs sanitised client records via the Fastify
  // logger (pino) and dedupes retries so a re-drained record is acked without
  // being double-logged. `fastify.log` is always present on a real instance;
  // fall back to a no-op only for bare mocks in tests.
  const logFn =
    fastify.log && typeof fastify.log.info === "function"
      ? (rec: SanitizedRecord & { layer: "client" }) =>
          fastify.log.info({ voiceTelemetry: rec }, "voice-input telemetry (client)")
      : () => undefined;
  const sink = new TelemetrySink(logFn);

  // Initial probe + background poll. Polling here is best-effort; the
  // PushToTalkButton client also polls health directly.
  void probeSidecar(state);
  const pollTimer = setInterval(() => {
    void probeSidecar(state);
  }, 5_000);
  fastify.addHook("onClose", async () => {
    clearInterval(pollTimer);
  });

  // Register a content-type parser for multipart/form-data + audio/* binary
  // bodies. Without this, Fastify 5.x rejects with HTTP 415
  // FST_ERR_CTP_INVALID_MEDIA_TYPE before the route handler runs, which
  // breaks the client's FormData POST. Buffer is exposed as request.body;
  // the handler reads it directly instead of via readRawBody().
  // Per SwiftViper voice-input-investigation /tmp/voice-input-investigation-report.md
  // (cross-machine root cause; Option B recommended-fix; operator-pre-ratified 2026-05-29 ~17:45 CEST verbatim "voice input - defaults").
  fastify.addContentTypeParser(
    /^multipart\/form-data|^audio\//,
    { parseAs: "buffer", bodyLimit: 50_000_000 },
    (_req, body, done) => done(null, body)
  );

  fastify.get("/api/plugins/voice-input/health", async (_request, reply) => {
    if (!state.sidecarHealthy) {
      void probeSidecar(state);
      return reply.code(503).send({ healthy: false });
    }
    return reply.code(200).send({ healthy: true, engine: state.cfg.engine });
  });

  // Telemetry sink (Layer 2 ingress for the CLIENT layer). The client POSTs its
  // local-first ring-buffer records here during drain. We sanitise + log +
  // dedupe, then ACK the exact (request_id, seq) pairs we accepted. The client
  // marks a record delivered ONLY on this body-level ack — so a manufactured
  // 200 (service worker, proxy) that carries no ack list releases nothing.
  fastify.post("/api/plugins/voice-input/telemetry", async (request, reply) => {
    const body = (request.body ?? {}) as {
      records?: unknown;
      degraded?: unknown;
      overflow?: unknown;
    };
    const records = Array.isArray(body.records) ? body.records : [];
    const result = sink.ingest(records);
    // Envelope-level degradation/overflow is logged INDEPENDENTLY of the
    // records — a client whose storage was unavailable sends a degraded notice
    // with an EMPTY records array (see telemetry.ts signalDegradedOnce), and
    // that fact must be server-observable even though there is nothing to ack.
    // Also surfaces overflow (records lost to eviction/quota) so buffer loss is
    // visible rather than silent.
    if (body.degraded === true || (typeof body.overflow === "number" && body.overflow > 0)) {
      if (fastify.log && typeof fastify.log.info === "function") {
        fastify.log.info(
          {
            voiceTelemetry: {
              layer: "client",
              event: "buffer_degraded",
              degraded: body.degraded === true,
              overflow: typeof body.overflow === "number" ? body.overflow : 0,
            },
          },
          "voice-input telemetry (client buffer degraded/overflow)"
        );
      }
    }
    // 200 with an explicit ack list naming each accepted (request_id, seq).
    return reply.code(200).send({ ok: true, acked: result.acked });
  });

  fastify.post("/api/plugins/voice-input/transcribe", async (request, reply) => {
    // Resolve the correlation id up front so EVERY exit path (incl. the
    // unhealthy-sidecar 503) carries it and is echoed to the client. This is
    // the dashboard-ingress record of Layer 2: its presence proves the POST
    // reached the proxy — which is exactly what a zero-POST failure lacks.
    const { id: requestId, clientAbsent } = resolveRequestId(request);
    const startedAt = Date.now();
    reply.header("X-Voice-Request-Id", requestId);

    const logEvent = (rec: Record<string, unknown>) => {
      if (fastify.log && typeof fastify.log.info === "function") {
        fastify.log.info(
          { voiceTelemetry: { layer: "dashboard", request_id: requestId, ...rec } },
          "voice-input telemetry (dashboard)"
        );
      }
    };

    // The dashboard's Fastify instance is constructed with
    // `connectionTimeout: 10_000` (server.ts ~line 610), which closes the
    // socket if no inbound activity occurs for 10s. Voice transcription via
    // whisper-fallback takes ~20-25s on iMac per W3.5 § 8; without raising
    // this per-request, the dashboard drops the proxy connection long before
    // the sidecar returns and the client sees "Empty reply from server".
    // Align the per-request timeout with our explicit AbortController budget.
    try {
      request.raw.setTimeout(state.cfg.requestTimeoutMs);
    } catch {
      /* defensive; older Node versions / mocked requests */
    }

    const reqCtype =
      (request.headers["content-type"] as string) || "application/octet-stream";
    // Size for the ingress log comes from the PRE-PARSED buffer only (Fastify's
    // content-type parser already buffered it — reading it consumes nothing).
    // We deliberately do NOT call readRawBody here: that must stay on the
    // healthy path so the sidecar-down early return keeps its exact prior
    // stream behaviour (no extra drain) and a byte-identical 503 response.
    const preParsed = request.body as Buffer | undefined;
    const reqBytes = Buffer.isBuffer(preParsed) ? preParsed.length : undefined;

    // ingress: the POST reached the dashboard. Sizes/types only — never body.
    logEvent({
      event: "ingress",
      blob_bytes: reqBytes,
      mime: reqCtype,
      client_id_absent: clientAbsent,
    });

    if (!state.sidecarHealthy) {
      void probeSidecar(state);
      logEvent({ event: "egress", http_status: 503, total_ms: Date.now() - startedAt, reason: "sidecar_unhealthy" });
      return reply.code(503).send({ error: "Voice sidecar unavailable" });
    }

    try {
      // request.body is the Buffer parsed by addContentTypeParser above; fall
      // back to readRawBody for legacy content-types not matched by the parser
      // regex (defense-in-depth). Unchanged from the pre-instrumentation path.
      const body = preParsed ?? (await readRawBody(request));
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        state.cfg.requestTimeoutMs
      );
      try {
        const upstream = await fetch(
          `${state.cfg.sidecarUrl}/transcribe?engine=${encodeURIComponent(state.cfg.engine)}`,
          {
            method: "POST",
            headers: {
              "content-type": reqCtype,
              // Forward the SAME correlation id to the sidecar so Layer 3 lines
              // up with Layers 1 + 2 under one id.
              "X-Voice-Request-Id": requestId,
            },
            // Node 20+ undici accepts Buffer; cast as BodyInit-compatible via unknown
            // (Buffer is a Uint8Array subclass; DOM lib's BodyInit doesn't include
            // Node Buffer in its type union).
            body: body as unknown as BodyInit,
            signal: controller.signal,
          }
        );
        clearTimeout(timer);
        const respBody = await upstream.text();
        // egress: the sidecar answered. Status + timing only.
        logEvent({ event: "egress", http_status: upstream.status, total_ms: Date.now() - startedAt });
        reply.code(upstream.status);
        const ct = upstream.headers.get("content-type");
        if (ct) reply.header("content-type", ct);
        return reply.send(respBody);
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // egress failure: proxy could not reach / read the sidecar. Error CLASS
      // only in structured telemetry; the human message stays in the response.
      logEvent({
        event: "egress",
        http_status: 502,
        total_ms: Date.now() - startedAt,
        net_error: e instanceof Error ? e.name : "unknown",
      });
      return reply.code(502).send({ error: `Sidecar proxy failed: ${msg}` });
    }
  });
}

async function readRawBody(request: FastifyRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.raw.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.raw.on("end", () => resolve(Buffer.concat(chunks)));
    request.raw.on("error", reject);
  });
}

// Plugin-runtime calls default(ctx) where ctx = { fastify, sessionManager, logger, ... }.
// register() expects raw Fastify instance. Unwrap here.
export default function(ctx: any) {
  const fastify = ctx && ctx.fastify ? ctx.fastify : ctx;
  return register(fastify);
};
