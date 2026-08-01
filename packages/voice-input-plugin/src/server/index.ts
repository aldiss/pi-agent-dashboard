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
import { join } from "node:path";
import { homedir } from "node:os";
import { emitSpoolEntry } from "./spool-emit.js";
import {
  CaptureStore,
  parseServedEngine,
  parseFallbackTaken,
  parseDecodedDurationMs,
  parseProcessingLatencyMs,
  parseAudioEnergy,
  parseEchoedRequestId,
  isValidCorrelationId,
} from "./capture-store.js";
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
  // dl-13765 req 2: bounded server-side capture records, keyed by correlationId,
  // so a failure survives the page. Built ONLY from server observations + the
  // coarse client linkage the ENUM gate already accepts. Never unbounded.
  captureStore: CaptureStore;
}

export type SessionNameResolver = (sessionId: string) => string | undefined;

interface RegisterOptions extends Partial<PluginConfig> {
  /** Resolve a target session through the dashboard's server-owned session model. */
  resolveSessionName?: SessionNameResolver;
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
  opts: RegisterOptions = {}
): Promise<void> {
  const { resolveSessionName, ...configOverrides } = opts;
  const state: PluginState = {
    cfg: { ...DEFAULTS, ...configOverrides },
    sidecarHealthy: false,
    captureStore: new CaptureStore(),
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

  // dl-13765 req 2: bounded read of the server-side capture records so a failure
  // survives the page. This reuses the EXISTING plugin route prefix — no new
  // public product surface. The store is bounded (≤200 records, coarse fields
  // only), so the response is inherently bounded. `?correlationId=<uuid>` returns
  // one joined record; no query returns the bounded list (newest first). Numbers/
  // enums/booleans/timestamps only — nothing reconstructable as audio.
  fastify.get<{ Querystring: { correlationId?: string } }>(
    "/api/plugins/voice-input/capture-records",
    async (request, reply) => {
      const id = request.query?.correlationId;
      if (typeof id === "string" && id.length > 0) {
        if (!isValidCorrelationId(id)) {
          return reply.code(400).send({ error: "invalid correlationId" });
        }
        const record = state.captureStore.get(id);
        return reply.code(200).send({ record: record ?? null });
      }
      return reply.code(200).send({
        records: state.captureStore.list(),
        count: state.captureStore.size(),
      });
    }
  );

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
    // dl-13765 req 2: on the already-validated `recording-stopped` linkage, stamp
    // the bounded store so the server-observed transcribe record joins the client
    // stop. Only the coarse fields the ENUM gate already validated are recorded —
    // the gate is NOT widened. Wrapped/swallowed: never affects the 204.
    if (isRecordingStopped) {
      try {
        state.captureStore.record(correlationId, {
          clientStopReason: stopReason,
          clientStopSizeClass: sizeClass,
          clientStopSeen: true,
        });
      } catch {
        /* observational */
      }
    }
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

    // dl-13765: persist server-OBSERVED capture fields keyed by correlationId,
    // bounded, so a failure survives the page. Observational: this records what
    // the server already sees; it never changes the proxy behaviour or timing,
    // and a store failure can never affect the response (wrapped, swallowed).
    const advertisedEngine = state.cfg.engine;
    const recordCapture = (fields: Record<string, unknown>): void => {
      try {
        if (!isValidCorrelationId(stopMetadata.correlationId)) return;
        state.captureStore.record(stopMetadata.correlationId, {
          advertisedEngine,
          ...fields,
        });
      } catch {
        /* observational — a store failure must never affect the response */
      }
    };

    if (!state.sidecarHealthy) {
      void probeSidecar(state);
      logIdentity(request, {
        phase: "proxy-health-gate",
        outcome: "sidecar-unhealthy",
        status: 503,
        ...proxyLogIdentity,
      });
      recordCapture({
        serverOutcome: "sidecar-unhealthy",
        httpStatus: 503,
        http502Class: "app-sidecar-unhealthy",
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
              // dl-13792 req 4: forward the correlation id so the sidecar echoes it
              // and its energy/duration record joins the captureAttemptId chain.
              ...(isValidCorrelationId(stopMetadata.correlationId)
                ? { "x-voice-request-id": stopMetadata.correlationId }
                : {}),
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

        // dl-13792: extract the sidecar's now-correct observation fields ONCE.
        // servedEngine/fallbackTaken are the sidecar's authoritative report; the
        // TRUE decoded duration is decoded_duration_ms (PCM-derived); the legacy
        // duration_ms is processing latency (kept, honestly labelled). Energy is a
        // bounded numbers-only aggregate. The sidecar echoes request_id for the join.
        const sidecarServedEngine = parseServedEngine(respBody);
        const sidecarFallbackExplicit = parseFallbackTaken(respBody);
        // dl-13862: fallback is TRI-STATE — known-true / known-false / unknown.
        // The bug this fixes: the old boolean collapse turned "we have no idea"
        // into a confident `false` (a reader would conclude the requested engine
        // served it and stop looking at exactly the point the real cause might be).
        //
        //  - explicit fallback_taken present (true OR false) → KNOWN, taken verbatim.
        //  - no explicit flag, served engine KNOWN → the served≠advertised heuristic
        //    may run (it has a real input to reason from) → KNOWN.
        //  - no explicit flag, served UNKNOWN (the legacy engine_used-only body) →
        //    UNKNOWN. The heuristic MUST NOT run — it has no input worth reasoning
        //    from — so we assert nothing, NEVER `false`.
        let sidecarFallbackKnown: boolean;
        let sidecarFallback: boolean; // meaningful ONLY when sidecarFallbackKnown
        if (sidecarFallbackExplicit !== null) {
          sidecarFallbackKnown = true;
          sidecarFallback = sidecarFallbackExplicit; // explicit true OR false, verbatim
        } else if (sidecarServedEngine !== "unknown") {
          sidecarFallbackKnown = true;
          sidecarFallback = sidecarServedEngine !== advertisedEngine; // heuristic on a KNOWN served
        } else {
          sidecarFallbackKnown = false;
          sidecarFallback = false; // placeholder ONLY; NOT stored while unknown (see below)
        }
        const decodedDurationMs = parseDecodedDurationMs(respBody); // TRUE audio length or null
        const processingLatencyMs = parseProcessingLatencyMs(respBody); // legacy latency or null
        const energy = parseAudioEnergy(respBody);
        const echoedRequestId = parseEchoedRequestId(respBody);
        const sidecarFields: Record<string, unknown> = {
          servedEngine: sidecarServedEngine,
          // dl-13862 tri-state, mirroring the decodedDurationMs/decodedDurationKnown
          // idiom already in this file. `fallbackTakenKnown` is ALWAYS stored and is
          // the authoritative signal. A boolean has NO out-of-band sentinel (unlike
          // decodedDurationMs=-1), so storing `false` for the unknown case WOULD BE
          // the very defect — therefore `fallbackTaken` is present ONLY when known
          // and ABSENT when unknown. That makes the three states three distinct
          // observable outcomes in the STORED record: known-true (fallbackTaken:true,
          // fallbackTakenKnown:true), known-false (fallbackTaken:false,
          // fallbackTakenKnown:true), unknown (fallbackTaken ABSENT,
          // fallbackTakenKnown:false). Explicit false is NEVER merged into unknown.
          fallbackTakenKnown: sidecarFallbackKnown,
          ...(sidecarFallbackKnown ? { fallbackTaken: sidecarFallback } : {}),
          // TRUE decoded duration (PCM). -1 sentinel only when the sidecar did not
          // report it (older build); never the processing-latency value.
          decodedDurationMs: decodedDurationMs ?? -1,
          decodedDurationKnown: decodedDurationMs !== null,
          // Legacy processing latency, kept + honestly labelled — NEVER audio length.
          processingLatencyMs: processingLatencyMs ?? -1,
          // dl-13792 req 4 (server half): server-side aggregate energy IS now
          // measured — in the SIDECAR, at the decode point — and forwarded here.
          serverEnergyMeasured: energy.energyPeak !== null || energy.energyFramesTotal !== null,
          serverEnergySource: "sidecar-pcm",
          energyPeak: energy.energyPeak ?? -1,
          energyRms: energy.energyRms ?? -1,
          energyFramesAbove: energy.energyFramesAbove ?? -1,
          energyFramesTotal: energy.energyFramesTotal ?? -1,
          sidecarEchoedRequestId: echoedRequestId,
          sidecarRequestIdJoins: echoedRequestId === stopMetadata.correlationId && echoedRequestId.length > 0,
        };

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
            // dl-13792: served engine + fallback + TRUE decoded duration + energy
            // now come from the sidecar (correct layer). Even on a 2xx-empty the
            // sidecar reports them. This 502 is an APPLICATION 502
            // (EmptyUpstreamTranscript), distinct from an edge/proxy 502.
            recordCapture({
              serverOutcome: "upstream-2xx-empty",
              serverOutcomeReason: verdict.reason,
              httpStatus: 502,
              http502Class: "app-2xx-empty",
              upstreamStatus: upstream.status,
              ...sidecarFields,
              upstreamBodySizeClass: sizeClass(respBody.length),
            });
            return reply.code(502).send({
              error:
                "Voice sidecar returned an empty transcript on a 200 response " +
                "(upstream contract violation)",
              type: "EmptyUpstreamTranscript",
            });
          }
          // NOTE: /transcribe is PANE-BLIND — it cannot know which pane a
          // dictation targets, so it MUST NOT emit a note spool here. Doing so
          // (the withdrawn G3 producer hop) turned every dictation, in every
          // pane, into a daily-note entry. Note production is Dawn-addressed
          // ONLY and lives on the dedicated /spool route below, which the client
          // calls exclusively for the Dawn recorder pane. Every non-Dawn pane
          // reaches this branch and produces ZERO spool by construction.

          // Valid non-empty transcript — forward the ORIGINAL bytes unchanged.
          logIdentity(request, {
            phase: "proxy-forward",
            outcome: "ok",
            status: upstream.status,
            ...proxyLogIdentity,
            bodySizeClass: sizeClass(respBody.length),
          });
          // dl-13769: the retention incident followed SUCCESSFUL transcripts, so
          // the success path is recorded too. dl-13792: served engine + fallback +
          // TRUE decoded duration + energy now come from the sidecar (correct
          // layer) — this is where "which engine served" and "did the upload carry
          // acoustic energy / how long was it" are finally answered.
          recordCapture({
            serverOutcome: "ok",
            httpStatus: upstream.status,
            http502Class: "none",
            upstreamStatus: upstream.status,
            ...sidecarFields,
            upstreamBodySizeClass: sizeClass(respBody.length),
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
        recordCapture({
          serverOutcome: "upstream-non-2xx",
          httpStatus: upstream.status,
          http502Class: "none",
          upstreamStatus: upstream.status,
          ...sidecarFields,
          upstreamBodySizeClass: sizeClass(respBody.length),
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
      // dl-13765 req 5: an APPLICATION 502 from a proxy exception (the fetch to
      // the sidecar threw — network/abort/timeout). Distinct from an edge 502.
      recordCapture({
        serverOutcome: "proxy-exception",
        httpStatus: 502,
        http502Class: "app-proxy-exception",
      });
      return reply.code(502).send({ error: `Sidecar proxy failed: ${msg}` });
    }
  });

  // DAWN-ONLY note-spool route. The client routes only the Dawn recorder pane
  // here, and the server independently resolves its target id through the
  // trusted session manager before accepting the body or emitting any files.
  // It writes the transcript + audio to a PRIVATE spool atomically and returns
  // only a PATH reference. The transcript bytes never travel onward to Dawn —
  // she receives the reference and invokes the installed engine/gateway, which
  // reads + hashes + appends. Path-only preserves the C15 identity chain.
  fastify.post<{ Querystring: { sessionId?: string } }>(
    "/api/plugins/voice-input/spool",
    {
      // Base64 expands the same 50 MB audio ceiling accepted by /transcribe.
      bodyLimit: 70_000_000,
      // Runs before Fastify parses the request body. A forged client claim is
      // irrelevant: only the server-owned session name returned for the target
      // session id can authorize this route.
      onRequest: async (request, reply) => {
        const sessionId = request.query.sessionId;
        if (!sessionId || resolveSessionName?.(sessionId) !== "Dawn") {
          return reply.code(403).send({ error: "Forbidden" });
        }
      },
    },
    async (request, reply) => {
      try {
        // Close the rename race between onRequest and emission. The first
        // check still guarantees non-Dawn bodies are rejected before parsing.
        if (resolveSessionName?.(request.query.sessionId ?? "") !== "Dawn") {
          return reply.code(403).send({ error: "Forbidden" });
        }
        const body = (request.body ?? {}) as {
          transcript?: unknown;
          audioBase64?: unknown;
        };
        const transcript =
          typeof body.transcript === "string" ? body.transcript : "";
        if (transcript.trim().length === 0) {
          return reply
            .code(422)
            .send({ error: "empty transcript", type: "EmptySpoolTranscript" });
        }
        const audio =
          typeof body.audioBase64 === "string"
            ? Buffer.from(body.audioBase64, "base64")
            : Buffer.alloc(0);
        const spoolDir =
          process.env.OBSIDIAN_VOICE_SPOOL_DIR ??
          join(homedir(), ".pi", "orchestration-state", "dawn-spool");
        const id = emitSpoolEntry(JSON.stringify({ transcript }), audio, {
          spoolDir,
        });
        if (id === null) {
          return reply
            .code(500)
            .send({ error: "spool write failed", type: "SpoolWriteFailed" });
        }
        // PATH-ONLY: return the reference, never echo the transcript back.
        // Dawn's contract is the exact spool ENTRY identity — the `.json`
        // sidecar, which IS the entry record the engine consumes via --entry.
        // Not the `.txt` (that is one field INSIDE the entry) and not the
        // directory (naming an entry but handing over a directory lets the
        // engine sweep siblings the caller never named). Derived here from
        // spoolDir + id so there is one tested source of truth.
        const entryPath = join(spoolDir, `${id}.json`);
        return reply.code(200).send({ ok: true, spoolDir, id, entryPath });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return reply.code(500).send({ error: `spool failed: ${msg}` });
      }
    },
  );
}

async function readRawBody(request: FastifyRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.raw.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.raw.on("end", () => resolve(Buffer.concat(chunks)));
    request.raw.on("error", reject);
  });
}

type PluginRuntimeContext = {
  fastify: FastifyInstance;
  sessionManager?: {
    getSession?: (id: string) => unknown;
  };
};

function resolvedSessionName(ctx: PluginRuntimeContext, sessionId: string): string | undefined {
  const session = ctx.sessionManager?.getSession?.(sessionId);
  if (typeof session !== "object" || session === null || !("name" in session)) return undefined;
  const name = (session as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}

// Plugin-runtime calls default(ctx) where ctx = { fastify, sessionManager, logger, ... }.
// Thread its trusted session lookup into the raw Fastify registrar.
export default function(ctx: FastifyInstance | PluginRuntimeContext) {
  if ("fastify" in ctx) {
    return register(ctx.fastify, {
      resolveSessionName: (sessionId) => resolvedSessionName(ctx, sessionId),
    });
  }
  return register(ctx);
}
