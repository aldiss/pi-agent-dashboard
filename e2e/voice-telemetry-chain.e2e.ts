/**
 * E2E chain driver (D4 rebuild) — proves ONE id propagates through the REAL
 * client code paths, not a synthesized POST.
 *
 * The original E2E (dl-12247) SYNTHESIZED both the sink POST and the transcribe
 * POST via `fastify.inject` with hand-built bodies. That made the chain "proof"
 * a claim about a hand-written payload, NOT about the client's real emit/drain.
 * Pete dl-12308 #4 + Daywright's verification-failure disclosure: a verdict file
 * is a claim ABOUT a test; only the test is a claim about the system. This
 * rebuild invokes the ACTUAL client telemetry module:
 *
 *   1. Client  → configureTelemetry() + emit() persist to a REAL localStorage
 *                (Node shim), then drain() ships them via REAL fetch to a
 *                LISTENING dashboard (not inject). Delivery is confirmed only by
 *                the server's body-ack — the exact acknowledged-drain path.
 *   2. Dashboard → the REAL plugin register() on a Fastify server bound to a
 *                real port; its pino logs are captured.
 *   3. Sidecar  → the REAL worktree-local sidecar app (stub backend) on its own
 *                port; receipt + transcribe records go to a JSONL file.
 *
 * Distinctness is proven with TWO REAL transcribe requests carrying DIFFERENT
 * ids (not health-poll noise — /health receipts are now scoped out): the sidecar
 * must record each id against its own request, never smear one id across both.
 *
 * Prints a JSON verdict AND (for review) a human-readable trace of where each id
 * appeared. Daywright will read THIS SOURCE, not the verdict.
 */
import Fastify from "fastify";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── Node localStorage shim ─────────────────────────────────────────────────
// The client telemetry module persists to `globalThis.localStorage` (a real
// browser API). To exercise its REAL emit/drain here, provide a minimal, spec-
// faithful shim BEFORE importing the module. This is the same contract the
// browser gives: getItem/setItem/removeItem over a string map, throwing is
// possible but we do not simulate quota here (the unit suite covers quota).
class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.has(k) ? (this.m.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, String(v));
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  clear(): void {
    this.m.clear();
  }
}
(globalThis as unknown as { localStorage: MemoryStorage }).localStorage = new MemoryStorage();

// Import the REAL client module + the REAL plugin AFTER the shim is installed.
const {
  configureTelemetry,
  emit: clientEmit,
  drain: clientDrain,
  _debugReadBuffer,
  _debugReset,
} = await import("../packages/voice-input-plugin/src/client/telemetry.ts");
const { register } = await import("../packages/voice-input-plugin/src/server/index.ts");

const HERE = dirname(fileURLToPath(import.meta.url));
const SIDECAR_ROOT = join(
  HERE, "..", "..", "voice-telemetry-daywright-20260726",
  "pi-extensions", "voice-input"
);
const SIDECAR_STUB = join(SIDECAR_ROOT, "e2e_sidecar_stub.py");
const SIDECAR_PY = join(SIDECAR_ROOT, ".venv-telemetry", "bin", "python");

// Two DISTINCT real ids for the two transcribe requests (distinctness proof).
const ID_A = "e2e-real-id-AAAA1111";
const ID_B = "e2e-real-id-BBBB2222";

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

/** Build a multipart body + its boundary content-type via the WHATWG Response. */
async function multipart(): Promise<{ body: Buffer; contentType: string }> {
  const form = new FormData();
  form.append("audio", new Blob([new Uint8Array(4096)], { type: "audio/webm" }), "r.webm");
  const enc = new Response(form);
  return {
    body: Buffer.from(await enc.arrayBuffer()),
    contentType: enc.headers.get("content-type") ?? "multipart/form-data",
  };
}

async function main() {
  _debugReset();
  const sidecarPort = await freePort();
  const dashPort = await freePort();
  const outDir = mkdtempSync(join(tmpdir(), "voice-e2e-"));
  const sidecarTelemetry = join(outDir, "sidecar-telemetry.jsonl");

  // 1) Launch the REAL worktree-local sidecar app (stub backend, own port).
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

  // 2) Stand up the REAL plugin on a LISTENING Fastify server (real port).
  const dashLogs: Array<Record<string, unknown>> = [];
  const fastify = Fastify({
    logger: {
      level: "info",
      stream: {
        write: (line: string) => {
          try {
            dashLogs.push(JSON.parse(line));
          } catch {
            /* non-JSON */
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
  await fastify.listen({ host: "127.0.0.1", port: dashPort });
  const base = `http://127.0.0.1:${dashPort}`;

  const okSidecar = await waitFor(async () => sidecarReady, 15_000);
  if (!okSidecar) {
    sidecar.kill("SIGKILL");
    await fastify.close();
    throw new Error("sidecar stub did not become ready");
  }
  // Wait for the dashboard's own health probe to see the sidecar as healthy.
  await waitFor(async () => {
    const r = await fetch(`${base}/api/plugins/voice-input/health`);
    return r.status === 200;
  }, 8_000);

  // Point the REAL client telemetry at the LISTENING sink endpoint.
  const sinkEndpoint = `${base}/api/plugins/voice-input/telemetry`;
  configureTelemetry(sinkEndpoint);

  // ── 3a) CLIENT LAYER — REAL emit() + drain() ──────────────────────────────
  // Emit two lifecycle events for ID_A exactly as PushToTalkButton would on a
  // zero-POST path (capture_start + a too_short no_post). These PERSIST to the
  // Node localStorage shim first.
  clientEmit(ID_A, "capture_start");
  clientEmit(ID_A, "no_post", { reason: "too_short", blob_bytes: 900, mime: "audio/webm" });
  const bufferedBeforeDrain = _debugReadBuffer().length;

  // REAL acknowledged drain over REAL fetch to the LISTENING server. Records are
  // cleared ONLY on the server's body-ack for their exact (request_id, seq).
  const confirmed = await clientDrain(sinkEndpoint);
  const bufferedAfterDrain = _debugReadBuffer().length;

  // ── 3b) TRANSCRIBE PROXY — REAL fetch, TWO distinct ids ───────────────────
  const mpA = await multipart();
  const proxyA = await fetch(`${base}/api/plugins/voice-input/transcribe`, {
    method: "POST",
    headers: { "x-voice-request-id": ID_A, "content-type": mpA.contentType },
    body: mpA.body,
  });
  const mpB = await multipart();
  const proxyB = await fetch(`${base}/api/plugins/voice-input/transcribe`, {
    method: "POST",
    headers: { "x-voice-request-id": ID_B, "content-type": mpB.contentType },
    body: mpB.body,
  });
  const echoedA = proxyA.headers.get("x-voice-request-id");
  const echoedB = proxyB.headers.get("x-voice-request-id");

  // Let the sidecar flush both transcribe+receipt records.
  await waitFor(
    async () =>
      existsSync(sidecarTelemetry) &&
      readFileSync(sidecarTelemetry, "utf8").includes(ID_A) &&
      readFileSync(sidecarTelemetry, "utf8").includes(ID_B),
    5_000
  );

  // ── Collect ────────────────────────────────────────────────────────────────
  const sidecarText = existsSync(sidecarTelemetry) ? readFileSync(sidecarTelemetry, "utf8") : "";
  const sidecarRecords = sidecarText
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l.replace(/^voice_telemetry\s+/, ""));
      } catch {
        return null;
      }
    })
    .filter(Boolean) as Array<Record<string, unknown>>;

  const clientLayerLogs = dashLogs.filter(
    (l) => (l.voiceTelemetry as Record<string, unknown>)?.layer === "client"
  );
  const proxyLayerLogs = dashLogs.filter(
    (l) => (l.voiceTelemetry as Record<string, unknown>)?.layer === "dashboard"
  );
  const idIn = (records: Array<Record<string, unknown>>, id: string, pick: (r: Record<string, unknown>) => unknown) =>
    records.some((r) => pick(r) === id);

  // Sidecar records for each id.
  const sideA = sidecarRecords.filter((r) => r.request_id === ID_A);
  const sideB = sidecarRecords.filter((r) => r.request_id === ID_B);
  const sideAEvents = sideA.map((r) => r.event).sort();
  const sideBEvents = sideB.map((r) => r.event).sort();
  // /health is scoped out of receipts now, so the only ids present should be the
  // two transcribe ids — no heartbeat noise. (Absent-client mints would appear
  // only if a request arrived without a valid id; none here.)
  const distinctIds = new Set(sidecarRecords.map((r) => r.request_id));

  // ── Human-readable trace (for the source-level read) ───────────────────────
  const trace = {
    client_buffer_before_drain: bufferedBeforeDrain, // 2 (persist-first)
    client_drain_confirmed: confirmed, // 2 (acked by real server body)
    client_buffer_after_drain: bufferedAfterDrain, // 0 (cleared on ack)
    dashboard_client_layer_ids: clientLayerLogs
      .map((l) => (l.voiceTelemetry as Record<string, unknown>)?.request_id)
      .filter(Boolean),
    dashboard_proxy_layer_ids: proxyLayerLogs
      .map((l) => (l.voiceTelemetry as Record<string, unknown>)?.request_id)
      .filter(Boolean),
    sidecar_ID_A_events: sideAEvents,
    sidecar_ID_B_events: sideBEvents,
    sidecar_distinct_ids: [...distinctIds],
  };

  const verdict = {
    // Client REAL emit/drain:
    real_client_persist_first: bufferedBeforeDrain === 2,
    real_client_drain_confirmed_two: confirmed === 2,
    real_client_buffer_cleared_on_ack: bufferedAfterDrain === 0,
    // Dashboard saw the client-layer records for ID_A via the REAL sink route:
    dashboard_client_layer_has_ID_A: idIn(
      clientLayerLogs.map((l) => l.voiceTelemetry as Record<string, unknown>),
      ID_A,
      (r) => r.request_id
    ),
    // Proxy logged both transcribe ids and echoed them:
    proxy_A_ok: proxyA.status === 200 && echoedA === ID_A,
    proxy_B_ok: proxyB.status === 200 && echoedB === ID_B,
    dashboard_proxy_layer_has_ID_A: idIn(
      proxyLayerLogs.map((l) => l.voiceTelemetry as Record<string, unknown>),
      ID_A,
      (r) => r.request_id
    ),
    dashboard_proxy_layer_has_ID_B: idIn(
      proxyLayerLogs.map((l) => l.voiceTelemetry as Record<string, unknown>),
      ID_B,
      (r) => r.request_id
    ),
    // Sidecar recorded each id against ITS OWN request (distinctness):
    sidecar_ID_A_has_receipt_and_transcribe:
      sideAEvents.includes("receipt") && sideAEvents.includes("transcribe"),
    sidecar_ID_B_has_receipt_and_transcribe:
      sideBEvents.includes("receipt") && sideBEvents.includes("transcribe"),
    sidecar_ids_are_distinct: distinctIds.has(ID_A) && distinctIds.has(ID_B) && distinctIds.size === 2,
    // Privacy: the stub transcript never reaches sidecar telemetry.
    sidecar_no_transcript: !sidecarText.includes("e2e-stub-transcript"),
  };

  sidecar.kill("SIGKILL");
  await fastify.close();

  const pass = Object.values(verdict).every(Boolean);
  console.log(JSON.stringify({ pass, verdict, trace }, null, 2));
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error("E2E driver error:", e);
  process.exit(2);
});
