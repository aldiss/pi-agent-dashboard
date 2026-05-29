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

  fastify.get("/api/plugins/voice-input/health", async (_request, reply) => {
    if (!state.sidecarHealthy) {
      void probeSidecar(state);
      return reply.code(503).send({ healthy: false });
    }
    return reply.code(200).send({ healthy: true, engine: state.cfg.engine });
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

    if (!state.sidecarHealthy) {
      void probeSidecar(state);
      return reply.code(503).send({ error: "Voice sidecar unavailable" });
    }

    try {
      const body = await readRawBody(request);
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
        reply.code(upstream.status);
        const ct = upstream.headers.get("content-type");
        if (ct) reply.header("content-type", ct);
        return reply.send(respBody);
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
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
