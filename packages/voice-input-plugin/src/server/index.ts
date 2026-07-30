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
import { emitSpoolEntry, wakeEngine, spoolConfigFromEnv } from "./spool-emit.js";
import type { FastifyInstance, FastifyRequest } from "fastify";

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

// ---------------------------------------------------------------------------
// Privacy-safe telemetry + defense-in-depth helpers (pure; unit-tested).
//
// Criterion 3: record phase / outcome / size-class / status — NEVER payload.
// Criterion 10: record which client bundle executed + the SW registration
// state, identity-only, so "which code ran on the device" (dl-12467 open
// observable) stops being unanswerable. No audio, no transcript, no content.
// ---------------------------------------------------------------------------

/** Coarse, non-reversible byte-size bucket (mirrors the sidecar's `_size_class`). */
export function sizeClass(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1024) return "<1KiB";
  if (n < 16 * 1024) return "1-16KiB";
  if (n < 256 * 1024) return "16-256KiB";
  if (n < 4 * 1024 * 1024) return "256KiB-4MiB";
  return ">=4MiB";
}

/**
 * Sanitise a client-supplied identity header before it reaches a log line.
 * The build id / SW-state headers are attacker-influenced, so we strip
 * control chars + whitespace (log-injection / newline-splitting defence) and
 * cap the length. Returns "unknown" for missing/empty input. This is IDENTITY
 * ONLY — the headers never carry transcript or audio content by construction.
 */
export function sanitizeIdentity(raw: unknown): string {
  if (typeof raw !== "string") return "unknown";
  const cleaned = raw.replace(/[^\x20-\x7E]/g, "").replace(/\s+/g, "").slice(0, 80);
  return cleaned.length > 0 ? cleaned : "unknown";
}

const STOP_REASONS = new Set([
  "manual-stop",
  "visibility-auto-stop",
  "safety-net-auto-stop",
]);
const REQUEST_ID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type StopMetadata = {
  stopReason: string;
  correlationId: string;
};

/**
 * Classify optional client metadata into fixed privacy-safe tokens. This
 * function deliberately has no acceptance result: observability metadata is
 * never allowed to gate the transcription path.
 */
function transcribeStopMetadata(request: FastifyRequest): StopMetadata {
  const rawReason = request.headers["x-voice-stop-reason"];
  const rawId = request.headers["x-voice-request-id"];
  const reasonMissing = rawReason === undefined;
  const idMissing = rawId === undefined;
  const reasonValid = typeof rawReason === "string" && STOP_REASONS.has(rawReason);
  const idValid = typeof rawId === "string" && REQUEST_ID_V4.test(rawId);
  return {
    stopReason: reasonMissing ? "unknown" : reasonValid ? rawReason as string : "invalid",
    correlationId: idMissing ? "unknown" : idValid ? rawId as string : "invalid",
  };
}

/**
 * Defense-in-depth for criterion 9 AT THE PROXY. The sidecar now guarantees
 * 200 ⟹ non-empty, but dl-12467 leaves "which sidecar actually ran" an open
 * observable — a stale sidecar could still emit a 200-empty. Inspect a 2xx
 * body and report whether it is a schema-valid non-empty transcript WITHOUT
 * mutating it. Returns:
 *   - {ok:true}  → forward the ORIGINAL bytes byte-identically.
 *   - {ok:false} → the proxy must NOT forward a 200-empty; synthesize a typed
 *                  non-2xx instead. `reason` classifies why (telemetry only).
 * Non-2xx bodies are never inspected here (they are already typed failures).
 */
export function inspectTranscriptEmptiness(
  body: string
): { ok: true } | { ok: false; reason: "non-json" | "missing-field" | "empty-field" } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, reason: "non-json" };
  }
  if (typeof parsed !== "object" || parsed === null || !("transcript" in parsed)) {
    return { ok: false, reason: "missing-field" };
  }
  const t = (parsed as { transcript?: unknown }).transcript;
  if (typeof t !== "string" || t.trim().length === 0) {
    return { ok: false, reason: "empty-field" };
  }
  return { ok: true };
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

export async function register(
  fastify: FastifyInstance,
  opts: Partial<PluginConfig> = {}
): Promise<void> {
  const state: PluginState = {
    cfg: { ...DEFAULTS, ...opts },
    sidecarHealthy: false,
  };

  // Initial probe + background poll. Polling here is best-effort; the
  // PushToTalkButton client also polls health directly.
  void probeSidecar(state);
  const pollTimer = setInterval(() => {
    void probeSidecar(state);
  }, 5_000);
  fastify.addHook("onClose", async () => {
    clearInterval(pollTimer);
  });

  /**
   * Emit ONE privacy-safe phase/outcome telemetry line. Prefers Fastify's
   * structured logger; falls back to console. Fields are a fixed identity +
   * phase set — never payload. `clientBuild` / `swState` come from request
   * headers the client stamps (criterion 10) and are sanitised at the call
   * site so a stale/forged header can't inject into the log.
   */
  type TelemetryLogger = {
    child?: (
      bindings: Record<string, string>,
      options?: { level?: string },
    ) => TelemetryLogger;
    info?: (message: string) => void;
    isLevelEnabled?: (level: string) => boolean;
  };

  // A dedicated child pins this one privacy-safe channel to info while still
  // using the host's configured Pino destination/transport. Pino child levels
  // are independent of a warn/silent parent. Fastify's logger:false abstract
  // logger has no effective isLevelEnabled capability, so that case falls back
  // to stdout. Exactly one branch emits each line.
  const rootLogger = (fastify as unknown as { log?: TelemetryLogger }).log;
  let telemetryLogger = rootLogger;
  try {
    if (rootLogger && typeof rootLogger.child === "function") {
      telemetryLogger = rootLogger.child(
        { component: "voice-telemetry" },
        { level: "info" },
      );
    }
  } catch {
    telemetryLogger = rootLogger;
  }

  const logPhase = (f: Record<string, string | number>): void => {
    const line = Object.entries(f)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    const message = `voice.telemetry ${line}`;
    if (
      telemetryLogger
      && typeof telemetryLogger.info === "function"
      && typeof telemetryLogger.isLevelEnabled === "function"
      && telemetryLogger.isLevelEnabled("info")
    ) {
      telemetryLogger.info(message);
    } else {
      console.info(message);
    }
  };

  // One identity line per request. The same latch is shared by handler outcome
  // logs and the lifecycle fallback, so a handler-produced 404 cannot be
  // doubled by onResponse.
  const identityLogged = new WeakSet<FastifyRequest>();
  const logIdentity = (
    request: FastifyRequest,
    fields: Record<string, string | number>,
  ): void => {
    if (identityLogged.has(request)) return;
    identityLogged.add(request);
    logPhase(fields);
  };

  const LIFECYCLE_OUTCOMES: Record<number, string> = {
    404: "route-not-found",
    413: "body-too-large",
    415: "unsupported-media-type",
  };
  fastify.addHook("onResponse", async (request, reply) => {
    const outcome = LIFECYCLE_OUTCOMES[reply.statusCode];
    if (!outcome || !request.url.startsWith("/api/plugins/voice-input/")) return;
    const metadata = transcribeStopMetadata(request);
    logIdentity(request, {
      phase: "proxy-lifecycle",
      outcome,
      status: reply.statusCode,
      engine: state.cfg.engine,
      clientBuild: sanitizeIdentity(request.headers["x-voice-client-build"]),
      swState: sanitizeIdentity(request.headers["x-voice-sw-state"]),
      stopReason: metadata.stopReason,
      correlationId: metadata.correlationId,
    });
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

  // Privacy-safe client PHASE telemetry (T2/T3). The pre-POST short-blob path
  // NEVER reaches /transcribe (nothing is sent), so without this endpoint the
  // operator's actual failure mode — a sub-1KiB blob — emits nothing at all.
  // The client posts a tiny fixed-shape JSON here for phases that don't (or
  // don't yet) carry a transcribe request. Body is validated against fixed
  // ENUM allowlists so it can only ever carry phase/outcome/size-CLASS —
  // never a transcript, audio, or an exact byte count (dl-12467: exact size
  // is itself a content side-channel; only coarse `sizeClass` buckets allowed).
  const TELEMETRY_PHASES = new Set(["pre-post", "client"]);
  const TELEMETRY_OUTCOMES = new Set([
    "short-blob",       // sub-1KiB blob, nothing sent
    "no-speech",        // client saw a typed 422 no-speech
    "empty-response",   // client saw a 200-empty / 502 empty-upstream
    "recording-stopped", // stop reason + request correlation, no payload
  ]);
  const TELEMETRY_SIZE_CLASSES = new Set([
    "0", "<1KiB", "1-16KiB", "16-256KiB", "256KiB-4MiB", ">=4MiB",
  ]);
  fastify.post("/api/plugins/voice-input/telemetry", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const phase = typeof body.phase === "string" ? body.phase : "";
    const outcome = typeof body.outcome === "string" ? body.outcome : "";
    const sizeClass =
      typeof body.sizeClass === "string" ? body.sizeClass : "";
    const stopReason =
      typeof body.stopReason === "string" ? body.stopReason : "";
    const correlationId =
      typeof body.requestId === "string" ? body.requestId : "";
    const isRecordingStopped = outcome === "recording-stopped";
    const validStopFields = isRecordingStopped
      ? phase === "client" && STOP_REASONS.has(stopReason) && REQUEST_ID_V4.test(correlationId)
      : body.stopReason === undefined && body.requestId === undefined;
    // Reject anything not on the allowlist — a client cannot smuggle content
    // through a free-form field because every accepted value is a fixed token.
    if (
      !TELEMETRY_PHASES.has(phase) ||
      !TELEMETRY_OUTCOMES.has(outcome) ||
      !TELEMETRY_SIZE_CLASSES.has(sizeClass) ||
      !validStopFields
    ) {
      return reply.code(400).send({ error: "invalid telemetry envelope" });
    }
    logIdentity(request, {
      phase: `client-${phase}`,
      outcome,
      status: 204,
      engine: state.cfg.engine,
      bodySizeClass: sizeClass,
      clientBuild: sanitizeIdentity(request.headers["x-voice-client-build"]),
      swState: sanitizeIdentity(request.headers["x-voice-sw-state"]),
      stopReason: isRecordingStopped ? stopReason : "unknown",
      correlationId: isRecordingStopped ? correlationId : "unknown",
    });
    return reply.code(204).send();
  });

  fastify.post("/api/plugins/voice-input/transcribe", async (request, reply) => {
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

    // Criterion 10: which client bundle executed + SW state, identity-only,
    // sanitised before it can reach a log line. Stamped by the client on
    // every transcribe POST (see PushToTalkButton.uploadBlob).
    const clientBuild = sanitizeIdentity(request.headers["x-voice-client-build"]);
    const swState = sanitizeIdentity(request.headers["x-voice-sw-state"]);
    const stopMetadata = transcribeStopMetadata(request);
    const proxyLogIdentity = {
      engine: state.cfg.engine,
      clientBuild,
      swState,
      stopReason: stopMetadata.stopReason,
      correlationId: stopMetadata.correlationId,
    };

    if (!state.sidecarHealthy) {
      void probeSidecar(state);
      logIdentity(request, {
        phase: "proxy-health-gate",
        outcome: "sidecar-unhealthy",
        status: 503,
        ...proxyLogIdentity,
      });
      return reply.code(503).send({ error: "Voice sidecar unavailable" });
    }

    try {
      // request.body is the Buffer parsed by addContentTypeParser above;
      // fall back to readRawBody for legacy content-types not matched by the
      // parser regex (defense-in-depth).
      const body = (request.body as Buffer | undefined) ?? (await readRawBody(request));
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
              "content-type":
                (request.headers["content-type"] as string) ||
                "application/octet-stream",
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
        const ct = upstream.headers.get("content-type");

        // DEFENSE-IN-DEPTH (criterion 9 at the proxy). The fixed sidecar
        // guarantees 200 ⟹ non-empty, but dl-12467 leaves "which sidecar ran"
        // an open observable — a stale sidecar could still emit a 200-empty.
        // On any 2xx, inspect (never mutate) the body: a schema-valid
        // non-empty transcript forwards BYTE-IDENTICALLY; a 2xx-empty is
        // converted to a typed 502 so the client never sees an empty 200.
        // Non-2xx bodies (the sidecar's own 422/500/503) pass through as-is.
        if (upstream.status >= 200 && upstream.status < 300) {
          const verdict = inspectTranscriptEmptiness(respBody);
          if (!verdict.ok) {
            logIdentity(request, {
              phase: "proxy-forward",
              outcome: `upstream-2xx-empty:${verdict.reason}`,
              status: 502,
              ...proxyLogIdentity,
              upstreamStatus: upstream.status,
              bodySizeClass: sizeClass(respBody.length),
            });
            return reply.code(502).send({
              error:
                "Voice sidecar returned an empty transcript on a 200 response " +
                "(upstream contract violation)",
              type: "EmptyUpstreamTranscript",
            });
          }
          // PRODUCER HOP (obsidian-daily-voice-record). The transcript is now
          // schema-valid and non-empty, so this is the single point at which a
          // real dictation is known good. Emission is non-regressive: any
          // failure is swallowed and the operator still receives their
          // transcript. Nothing is written outside the engine's spool contract.
          try {
            const spoolCfg = spoolConfigFromEnv();
            if (emitSpoolEntry(respBody, body, spoolCfg) !== null) {
              wakeEngine(spoolCfg);
            }
          } catch {
            /* never let the producer hop affect the transcription result */
          }

          // Valid non-empty transcript — forward the ORIGINAL bytes unchanged.
          logIdentity(request, {
            phase: "proxy-forward",
            outcome: "ok",
            status: upstream.status,
            ...proxyLogIdentity,
            bodySizeClass: sizeClass(respBody.length),
          });
          reply.code(upstream.status);
          if (ct) reply.header("content-type", ct);
          return reply.send(respBody);
        }

        // Non-2xx: a typed upstream failure (422 no-speech, 500, 503).
        // Forward verbatim so the client can render a DISTINCT state.
        logIdentity(request, {
          phase: "proxy-forward",
          outcome: "upstream-non-2xx",
          status: upstream.status,
          ...proxyLogIdentity,
          bodySizeClass: sizeClass(respBody.length),
        });
        reply.code(upstream.status);
        if (ct) reply.header("content-type", ct);
        return reply.send(respBody);
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logIdentity(request, {
        phase: "proxy-forward",
        outcome: "proxy-exception",
        status: 502,
        ...proxyLogIdentity,
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
