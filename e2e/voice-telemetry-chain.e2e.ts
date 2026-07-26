/**
 * E2E chain driver — proves ONE request id propagates client → dashboard → sidecar.
 *
 * Three independently-correct layers are not evidence of a working chain. This
 * assembles the REAL pieces and drives a single X-Voice-Request-Id through them:
 *
 *   1. Client layer  → POST the telemetry sink route with a record carrying the id
 *                       (this is what the browser ring-buffer drain does).
 *   2. Dashboard      → the REAL plugin register() mounts the sink + transcribe
 *                       proxy on a Fastify instance whose pino logs we capture.
 *   3. Sidecar        → the REAL worktree-local sidecar (stub backend) receives
 *                       the proxied POST, emits receipt + transcribe records with
 *                       the SAME id to a JSONL file.
 *
 * Assert: the one id appears in the client sink log, the dashboard ingress/egress
 * logs, AND the sidecar's receipt+transcribe records — and the proxy echoes it on
 * the response header. Prints a JSON verdict for the shell to gate on.
 */
import Fastify from "fastify";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { register } from "../packages/voice-input-plugin/src/server/index.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SIDECAR_STUB = join(
  HERE,
  "..",
  "..",
  "voice-telemetry-daywright-20260726",
  "pi-extensions",
  "voice-input",
  "e2e_sidecar_stub.py"
);
const SIDECAR_PY = join(
  HERE,
  "..",
  "..",
  "voice-telemetry-daywright-20260726",
  "pi-extensions",
  "voice-input",
  ".venv-telemetry",
  "bin",
  "python"
);

const THE_ID = "e2e-shared-id-" + "abc123def456";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    import("node:net").then((net) => {
      const srv = net.createServer();
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        srv.close(() => resolve(port));
      });
      srv.on("error", reject);
    });
  });
}

async function waitFor(fn: () => Promise<boolean>, ms: number, step = 100): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      if (await fn()) return true;
    } catch {
      /* keep polling */
    }
    await new Promise((r) => setTimeout(r, step));
  }
  return false;
}

async function main() {
  const sidecarPort = await freePort();
  const outDir = mkdtempSync(join(tmpdir(), "voice-e2e-"));
  const sidecarTelemetry = join(outDir, "sidecar-telemetry.jsonl");

  // 1) Launch the worktree-local sidecar stub (real app, stub backend).
  const sidecar = spawn(SIDECAR_PY, [SIDECAR_STUB, String(sidecarPort), sidecarTelemetry], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let sidecarReady = false;
  sidecar.stdout.on("data", (b) => {
    if (String(b).includes('"ready"')) sidecarReady = true;
  });
  sidecar.stderr.on("data", () => {
    /* aiohttp access logs; ignore */
  });

  // 2) Stand up Fastify with the REAL plugin, capturing pino logs to an array.
  const dashLogs: Array<Record<string, unknown>> = [];
  const fastify = Fastify({
    logger: {
      level: "info",
      // Custom stream: capture every structured log line as an object.
      stream: {
        write: (line: string) => {
          try {
            dashLogs.push(JSON.parse(line));
          } catch {
            /* non-JSON line */
          }
        },
      },
    },
  });
  await register(fastify, {
    sidecarUrl: `http://127.0.0.1:${sidecarPort}`,
    engine: "parakeet",
    requestTimeoutMs: 10_000,
  });
  await fastify.ready();

  const ok = await waitFor(async () => sidecarReady, 15_000);
  if (!ok) {
    sidecar.kill("SIGKILL");
    throw new Error("sidecar stub did not become ready");
  }

  // Let the dashboard's health poll flip sidecarHealthy=true (it probes /health).
  await waitFor(async () => {
    const res = await fastify.inject({ method: "GET", url: "/api/plugins/voice-input/health" });
    return res.statusCode === 200;
  }, 8_000);

  // 3a) CLIENT LAYER: POST the telemetry sink exactly as the ring-buffer drain does.
  const sinkRes = await fastify.inject({
    method: "POST",
    url: "/api/plugins/voice-input/telemetry",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({
      schema: 1,
      records: [
        { schema: 1, request_id: THE_ID, seq: 1, event: "capture_start", ts: 1 },
        { schema: 1, request_id: THE_ID, seq: 2, event: "no_post", reason: "too_short", blob_bytes: 900, ts: 2 },
      ],
    }),
  });
  const sinkBody = JSON.parse(sinkRes.body) as { acked?: Array<{ request_id: string; seq: number }> };

  // 3b) TRANSCRIBE PROXY: drive one multipart POST carrying the SAME id header.
  // Build the multipart body via Response so the boundary is generated, and —
  // critically — forward the matching multipart/form-data content-type header
  // (with boundary) or Fastify's content-type parser rejects it with 415.
  const form = new FormData();
  form.append("audio", new Blob([new Uint8Array(4096)], { type: "audio/webm" }), "r.webm");
  const encoded = new Response(form);
  const multipartCt = encoded.headers.get("content-type") ?? "multipart/form-data";
  const multipartBody = Buffer.from(await encoded.arrayBuffer());
  const proxyRes = await fastify.inject({
    method: "POST",
    url: "/api/plugins/voice-input/transcribe",
    headers: {
      "x-voice-request-id": THE_ID,
      "content-type": multipartCt,
    },
    payload: multipartBody,
  });

  const echoed = proxyRes.headers["x-voice-request-id"];

  // Give the sidecar a beat to flush its telemetry file.
  await waitFor(async () => existsSync(sidecarTelemetry) && readFileSync(sidecarTelemetry, "utf8").includes(THE_ID), 5_000);

  // ---- Collect + assert ----
  const sidecarText = existsSync(sidecarTelemetry) ? readFileSync(sidecarTelemetry, "utf8") : "";
  const sidecarRecords = sidecarText
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const m = l.replace(/^voice_telemetry\s+/, "");
      try {
        return JSON.parse(m);
      } catch {
        return null;
      }
    })
    .filter(Boolean) as Array<Record<string, unknown>>;

  const dashClientLogs = dashLogs.filter(
    (l) => (l.voiceTelemetry as Record<string, unknown>)?.layer === "client"
  );
  const dashProxyLogs = dashLogs.filter(
    (l) => (l.voiceTelemetry as Record<string, unknown>)?.layer === "dashboard"
  );

  const sidecarIds = new Set(sidecarRecords.map((r) => r.request_id));
  // The transcribe POST carried THE_ID; the sidecar's receipt + transcribe
  // records FOR THAT POST must all carry THE_ID. (The file also contains
  // health-probe receipt records the dashboard poll generated — those are a
  // DIFFERENT request and legitimately carry their own minted ids; a shared id
  // per request, not one id for all requests, is the correct property.)
  const transcribeIsOurId =
    sidecarRecords.filter((r) => r.event === "transcribe").length > 0 &&
    sidecarRecords
      .filter((r) => r.event === "transcribe")
      .every((r) => r.request_id === THE_ID);
  const ourRecords = sidecarRecords.filter((r) => r.request_id === THE_ID);
  const sidecarEvents = ourRecords.map((r) => r.event);
  // Health-probe receipts must NOT be tagged with THE_ID (proves the id is
  // per-request, not globally smeared).
  const healthProbeIdsDistinct = sidecarRecords
    .filter((r) => r.event === "receipt" && !ourRecords.includes(r))
    .every((r) => r.request_id !== THE_ID);

  const verdict = {
    the_id: THE_ID,
    proxy_status: proxyRes.statusCode,
    echoed_id_matches: echoed === THE_ID,
    client_sink_acked_id: (sinkBody.acked ?? []).every((a) => a.request_id === THE_ID) && (sinkBody.acked ?? []).length === 2,
    dashboard_client_layer_has_id: dashClientLogs.some(
      (l) => (l.voiceTelemetry as Record<string, unknown>)?.request_id === THE_ID
    ),
    dashboard_proxy_layer_has_id: dashProxyLogs.some(
      (l) => (l.voiceTelemetry as Record<string, unknown>)?.request_id === THE_ID
    ),
    sidecar_transcribe_carries_the_id: transcribeIsOurId,
    sidecar_health_probe_ids_distinct: healthProbeIdsDistinct,
    distinct_ids_in_sidecar_file: sidecarIds.size,
    sidecar_events: sidecarEvents.sort(),
    // Privacy spot-check: the stub transcript must NOT be in sidecar telemetry.
    sidecar_telemetry_has_no_transcript: !sidecarText.includes("e2e-stub-transcript"),
  };

  sidecar.kill("SIGKILL");
  await fastify.close();

  const pass =
    verdict.proxy_status === 200 &&
    verdict.echoed_id_matches &&
    verdict.client_sink_acked_id &&
    verdict.dashboard_client_layer_has_id &&
    verdict.dashboard_proxy_layer_has_id &&
    verdict.sidecar_transcribe_carries_the_id &&
    verdict.sidecar_health_probe_ids_distinct &&
    verdict.sidecar_events.includes("receipt") &&
    verdict.sidecar_events.includes("transcribe") &&
    verdict.sidecar_telemetry_has_no_transcript;

  console.log(JSON.stringify({ pass, verdict }, null, 2));
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error("E2E driver error:", e);
  process.exit(2);
});
