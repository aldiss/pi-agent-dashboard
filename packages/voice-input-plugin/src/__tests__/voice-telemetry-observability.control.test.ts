/**
 * Voice control M3 + M4 + M5 (SERVER), redesigned to run in a plain git-archive
 * checkout: imports the REAL in-repo `register` by relative path and drives it
 * through a real Fastify instance via `inject` (GREEN), and proves able-to-fail
 * against in-repo legacy behaviour fixtures (RED). No aliases, no orchestration-
 * state paths, no external codebase copy.
 *
 * M3 — the privacy-safe identity line survives a warn / silent / loggerInstance
 *      host logger, reaching exactly one sink.
 * M4 — telemetry metadata (absent / half / malformed) can never gate the
 *      transcription path: every case still transcribes.
 * M5 — a pre-handler framework rejection (413 / 415 / 404) still emits exactly
 *      one identity line, with no duplication on the normal path.
 */
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import pino from "pino";
import { register } from "../server/index.js";
import {
  legacyEmitPhase,
  legacyTranscribeGate,
  legacyPreHandlerIdentity,
} from "./__fixtures__/legacy-behaviours.js";

const TRANSCRIBE = "/api/plugins/voice-input/transcribe";
const AUDIO = Buffer.alloc(4096, 0x11);
const VALID_ID = "123e4567-e89b-42d3-a456-426614174000";

class CaptureStream extends Writable {
  chunks: string[] = [];
  _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
    this.chunks.push(String(chunk));
    cb();
  }
  text(): string { return this.chunks.join(""); }
}

let apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  vi.restoreAllMocks();
});

function installSidecar(): ReturnType<typeof vi.fn> {
  const stub = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/health")) return new Response("{}", { status: 200 });
    return new Response(JSON.stringify({ transcript: "synthetic-nonempty" }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  });
  globalThis.fetch = stub as typeof fetch;
  return stub;
}
async function ready(app: FastifyInstance): Promise<void> {
  apps.push(app);
  await register(app, { sidecarUrl: "http://sidecar.invalid" });
  await new Promise((r) => setTimeout(r, 0));
}
function voiceLines(text: string): string[] {
  return text.split("\n").filter((l) => l.includes("voice.telemetry"));
}
async function loggerCase(kind: "warn" | "silent" | "loggerInstance"): Promise<Record<string, unknown>> {
  const sink = new CaptureStream();
  const consoleLines: string[] = [];
  const spy = vi.spyOn(console, "info").mockImplementation((...a: unknown[]) => {
    consoleLines.push(a.map(String).join(" "));
  });
  sink.write("known-positive-sink-probe\n");
  console.info("known-positive-console-probe");
  const app = kind === "loggerInstance"
    ? Fastify({ loggerInstance: pino({ level: "warn" }, sink) })
    : Fastify({ logger: { level: kind, stream: sink } });
  installSidecar();
  await ready(app as unknown as FastifyInstance);
  const res = await app.inject({
    method: "POST", url: TRANSCRIBE,
    headers: { "content-type": "audio/webm", "x-voice-stop-reason": "manual-stop", "x-voice-request-id": VALID_ID },
    payload: AUDIO,
  });
  const sinkTel = voiceLines(sink.text());
  const consoleTel = consoleLines.filter((l) => l.includes("voice.telemetry"));
  const out = {
    status: res.statusCode,
    sinkProbe: sink.text().includes("known-positive-sink-probe"),
    consoleProbe: consoleLines.includes("known-positive-console-probe"),
    sinkTelemetry: sinkTel.length,
    consoleTelemetry: consoleTel.length,
    totalTelemetry: sinkTel.length + consoleTel.length,
  };
  spy.mockRestore();
  return out;
}

describe("voice control M3 — identity line survives warn/silent/loggerInstance", () => {
  it("GREEN: real server emits exactly one sink line in each config", async () => {
    const warn = await loggerCase("warn");
    const silent = await loggerCase("silent");
    const loggerInstance = await loggerCase("loggerInstance");
    console.log(`CONTROL M3 GREEN ${JSON.stringify({ warn, silent, loggerInstance })}`);
    for (const r of [warn, silent, loggerInstance]) {
      expect(r.status).toBe(200);
      expect(r.sinkProbe).toBe(true);              // known-positive
      expect(r.consoleProbe).toBe(true);           // known-positive
      expect(r.totalTelemetry).toBe(1);
      expect(r.sinkTelemetry).toBe(1);
      expect(r.consoleTelemetry).toBe(0);
    }
  });

  it("ABLE-TO-FAIL: the pre-fix hasOwnProperty gate drops the line under warn/silent", () => {
    const pinoLines: string[] = [];
    const consoleLines: string[] = [];
    const sinks = { pino: (m: string) => pinoLines.push(m), console: (m: string) => consoleLines.push(m) };
    // logger present (hasOwnProperty 'info' true) but effective level warn → info dropped, no fallback.
    const logger = { info: (_m: string) => {} };
    legacyEmitPhase(logger, (lvl) => lvl !== "info", "voice.telemetry x=1", sinks);
    const total = pinoLines.length + consoleLines.length;
    console.log(`CONTROL M3 RED(legacy) ${JSON.stringify({ pino: pinoLines.length, console: consoleLines.length, total })}`);
    expect(total).toBe(0);                         // the identity line vanished
  });
});

describe("voice control M4 — metadata cannot gate transcription", () => {
  it("GREEN: absent, half, and malformed metadata all transcribe (real server)", async () => {
    const consoleLines: string[] = [];
    const spy = vi.spyOn(console, "info").mockImplementation((...a: unknown[]) => {
      consoleLines.push(a.map(String).join(" "));
    });
    console.info("known-positive-console-probe");
    const sidecar = installSidecar();
    const app = Fastify({ logger: false });
    await ready(app);
    const cases = [
      { name: "absent", headers: {} },
      { name: "half", headers: { "x-voice-stop-reason": "manual-stop" } },
      { name: "malformed", headers: { "x-voice-stop-reason": "not-allowed", "x-voice-request-id": "not-a-uuid" } },
    ];
    const observed: Array<Record<string, unknown>> = [];
    for (const entry of cases) {
      const res = await app.inject({
        method: "POST", url: TRANSCRIBE,
        headers: { "content-type": "audio/webm", ...entry.headers }, payload: AUDIO,
      });
      observed.push({
        name: entry.name, status: res.statusCode,
        transcriptSucceeded: res.statusCode === 200 && typeof res.json().transcript === "string" && res.json().transcript.length > 0,
      });
    }
    const upstreamCalls = sidecar.mock.calls.filter((c) => String(c[0]).includes("/transcribe")).length;
    const consoleProbe = consoleLines.includes("known-positive-console-probe");
    spy.mockRestore();
    console.log(`CONTROL M4 GREEN ${JSON.stringify({ consoleProbe, upstreamCalls, cases: observed })}`);
    expect(consoleProbe).toBe(true);               // known-positive
    expect(upstreamCalls).toBe(3);
    for (const r of observed) { expect(r.status).toBe(200); expect(r.transcriptSucceeded).toBe(true); }
  });

  it("ABLE-TO-FAIL: the pre-fix gate 400s half/malformed before upstream", () => {
    const half = legacyTranscribeGate("manual-stop", undefined);
    const malformed = legacyTranscribeGate("not-allowed", "not-a-uuid");
    const absent = legacyTranscribeGate(undefined, undefined);
    console.log(`CONTROL M4 RED(legacy) ${JSON.stringify({ absent, half, malformed })}`);
    expect(absent.status).toBe(200);               // known-positive: absent still worked pre-fix
    expect(half.status).toBe(400);                 // but half → hard failure
    expect(malformed.status).toBe(400);            // and malformed → hard failure
  });
});

describe("voice control M5 — pre-handler 413/415/404 identity, no duplication", () => {
  it("GREEN: real server emits exactly one identity line for each pre-handler reject + normal", async () => {
    const consoleLines: string[] = [];
    const spy = vi.spyOn(console, "info").mockImplementation((...a: unknown[]) => {
      consoleLines.push(a.map(String).join(" "));
    });
    console.info("known-positive-console-probe");
    installSidecar();
    const app = Fastify({ logger: false });
    await ready(app);
    const ids = {
      body413: "00000000-0000-4000-8000-000000000001",
      media415: "00000000-0000-4000-8000-000000000002",
      route404: "00000000-0000-4000-8000-000000000003",
      normal: "00000000-0000-4000-8000-000000000004",
    };
    const h = (id: string) => ({ "x-voice-stop-reason": "visibility-auto-stop", "x-voice-request-id": id });
    const body413 = await app.inject({ method: "POST", url: TRANSCRIBE, headers: { "content-type": "audio/webm", ...h(ids.body413) }, payload: Buffer.alloc(50_000_001, 0x11) });
    const media415 = await app.inject({ method: "POST", url: TRANSCRIBE, headers: { "content-type": "application/x-voice-unsupported", ...h(ids.media415) }, payload: Buffer.from([0x11]) });
    const route404 = await app.inject({ method: "POST", url: "/api/plugins/voice-input/not-a-route", headers: h(ids.route404) });
    const normal = await app.inject({ method: "POST", url: TRANSCRIBE, headers: { "content-type": "audio/webm", ...h(ids.normal) }, payload: AUDIO });
    const telemetry = consoleLines.filter((l) => l.includes("voice.telemetry"));
    const counts = Object.fromEntries(Object.entries(ids).map(([n, id]) => [n, telemetry.filter((l) => l.includes(`correlationId=${id}`)).length]));
    const statuses = { body413: body413.statusCode, media415: media415.statusCode, route404: route404.statusCode, normal: normal.statusCode };
    const consoleProbe = consoleLines.includes("known-positive-console-probe");
    spy.mockRestore();
    console.log(`CONTROL M5 GREEN ${JSON.stringify({ consoleProbe, statuses, counts })}`);
    expect(consoleProbe).toBe(true);               // known-positive
    expect(statuses).toEqual({ body413: 413, media415: 415, route404: 404, normal: 200 });
    expect(counts.normal).toBe(1);                 // known-positive for the same filter
    expect(counts.body413).toBe(1);
    expect(counts.media415).toBe(1);
    expect(counts.route404).toBe(1);
  });

  it("ABLE-TO-FAIL: the pre-fix handler-only logger emits nothing for pre-handler rejects", () => {
    const normal = legacyPreHandlerIdentity(true);   // reached handler
    const body413 = legacyPreHandlerIdentity(false); // rejected before handler
    const media415 = legacyPreHandlerIdentity(false);
    const route404 = legacyPreHandlerIdentity(false);
    console.log(`CONTROL M5 RED(legacy) ${JSON.stringify({ normal, body413, media415, route404 })}`);
    expect(normal.lines).toBe(1);                    // known-positive: normal path logged pre-fix
    expect(body413.lines).toBe(0);                   // but pre-handler rejects logged nothing
    expect(media415.lines).toBe(0);
    expect(route404.lines).toBe(0);
  });
});
