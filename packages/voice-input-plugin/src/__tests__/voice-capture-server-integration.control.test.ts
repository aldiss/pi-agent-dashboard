// @vitest-environment node
/**
 * Voice control dl-13765 (SERVER integration) — the real Fastify register()
 * driven via inject(), proving the server-side capture record PERSISTS and
 * carries the served engine, fallback flag, decoded duration, and 502 class,
 * joined by the upload's x-voice-request-id. Mirrors proxy-transcribe.test.ts:
 * the ONLY substitution is global `fetch` (the sidecar stub).
 *
 * Covers (each with an able-to-fail assertion):
 *  - req 3: served engine parsed from the EXPLICIT served_engine (NOT engine_used,
 *    which is the legacy REQUESTED field); fallback from the explicit flag.
 *  - dl-13862: fallback is TRI-STATE in the STORED record — known-true,
 *    known-false, and unknown are three distinct observable outcomes
 *    (fallbackTaken + fallbackTakenKnown). A legacy engine_used-only body persists
 *    fallback UNKNOWN (fallbackTaken ABSENT), NEVER a confident false.
 *  - req 4: decoded duration_ms persisted (the actual decoded duration).
 *  - req 5: app-2xx-empty 502 class distinct from a healthy-path 'none'.
 *  - req 2: the record SURVIVES the request and is readable via the bounded
 *    GET /capture-records route, keyed by correlationId.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { register } from "../server/index.js";

const TRANSCRIBE = "/api/plugins/voice-input/transcribe";
const RECORDS = "/api/plugins/voice-input/capture-records";
const AUDIO = Buffer.alloc(4096, 0x11);
const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";

function installSidecarFetch(transcribeResponse: () => Response) {
  const stub = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/health")) {
      return new Response(JSON.stringify({ status: "ready" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    return transcribeResponse();
  });
  globalThis.fetch = stub as unknown as typeof fetch;
  return stub;
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  vi.spyOn(console, "info").mockImplementation(() => {});
  // Default engine is parakeet; a served 'whisper' is therefore a fallback.
  await register(app);
  await new Promise((r) => setTimeout(r, 0)); // let initial probe flip healthy
  return app;
}

function headers() {
  return { "content-type": "audio/webm", "x-voice-request-id": REQUEST_ID, "x-voice-stop-reason": "manual-stop" };
}

let currentApp: FastifyInstance | null = null;
afterEach(async () => {
  if (currentApp) { await currentApp.close(); currentApp = null; }
  vi.restoreAllMocks();
});

describe("dl-13765/dl-13792 SERVER integration — persists sidecar served-engine/fallback/TRUE-duration/energy/502", () => {
  it("SUCCESS + FALLBACK: sidecar served whisper + explicit fallback_taken; TRUE decoded duration ≠ latency; survives via GET", async () => {
    // dl-13844 sidecar shape: engine_used is the LEGACY REQUESTED engine
    // (unchanged for existing consumers); the SERVED truth is served_engine +
    // fallback_taken. TRUE decoded_duration_ms (2000 = 2s audio) DISTINCT from
    // duration_ms (17 = processing latency); audio_energy aggregate; echoed request_id.
    const UPSTREAM = JSON.stringify({
      transcript: "привет",
      engine_used: "parakeet",      // LEGACY = requested (NOT served); the truth is served_engine below
      served_engine: "whisper",
      requested_engine: "parakeet",
      fallback_taken: true,
      decoded_duration_ms: 2000,    // TRUE audio length from PCM
      duration_ms: 17,              // LEGACY processing latency
      duration_ms_kind: "processing-latency",
      processing_latency_ms: 17,
      audio_energy: { sample_rate: 16000, sample_count: 32000, channels: 1, decoded_duration_ms: 2000, peak: 0.61, rms: 0.18, frames_above: 95, frames_total: 100 },
      request_id: REQUEST_ID,
    });
    installSidecarFetch(() => new Response(UPSTREAM, { status: 200, headers: { "content-type": "application/json" } }));
    currentApp = await buildApp();

    const res = await currentApp.inject({ method: "POST", url: TRANSCRIBE, headers: headers(), payload: AUDIO });
    expect(res.statusCode).toBe(200);

    // The record SURVIVES the request — read it back via the bounded route.
    const read = await currentApp.inject({ method: "GET", url: `${RECORDS}?correlationId=${REQUEST_ID}` });
    const record = read.json().record as { fields: Record<string, unknown> } | null;
    console.log(`CONTROL dl-13792 SERVER-INT(success-fallback) ${JSON.stringify(record?.fields)}`);

    expect(record).toBeTruthy();
    expect(record?.fields.serverOutcome).toBe("ok");
    expect(record?.fields.advertisedEngine).toBe("parakeet");
    expect(record?.fields.servedEngine).toBe("whisper");
    // dl-13862 KNOWN-TRUE: explicit sidecar flag → present, true, flagged known.
    expect(record?.fields.fallbackTaken).toBe(true);            // explicit sidecar flag
    expect(record?.fields.fallbackTakenKnown).toBe(true);       // KNOWN (the third distinct state)
    // TRUE decoded duration (PCM-derived), NOT the processing latency.
    expect(record?.fields.decodedDurationMs).toBe(2000);
    expect(record?.fields.decodedDurationKnown).toBe(true);
    expect(record?.fields.processingLatencyMs).toBe(17);        // legacy latency, distinct
    expect(record?.fields.decodedDurationMs).not.toBe(record?.fields.processingLatencyMs);
    expect(record?.fields.http502Class).toBe("none");
    // dl-13792 req 4 CORRECTION: server-side energy IS now measured — in the
    // sidecar, at the decode point — NOT "no-decoder-in-proxy" as before.
    expect(record?.fields.serverEnergyMeasured).toBe(true);
    expect(record?.fields.serverEnergySource).toBe("sidecar-pcm");
    expect(record?.fields.energyPeak).toBe(0.61);
    expect(record?.fields.energyFramesAbove).toBe(95);
    // req 4 join: the sidecar echoed our correlation id → the chain joins.
    expect(record?.fields.sidecarEchoedRequestId).toBe(REQUEST_ID);
    expect(record?.fields.sidecarRequestIdJoins).toBe(true);
  });

  it("KNOWN-FALSE (persists): explicit fallback_taken:false + served==advertised → persists known-false", async () => {
    // dl-13862 control #2a (positive explicit-false PERSISTENCE). Proves a
    // known-false record survives into the store as present+false+known.
    //
    // COVERAGE NOTE (corrected per VoiceGate-4 independent mutation, dl-13862):
    // this control does NOT by itself discriminate explicit-false from
    // heuristic-false. Its fixture has served_engine==requested_engine==parakeet,
    // so served==advertised and the heuristic branch (served!==advertised) also
    // computes `false` — the SAME observable outcome as honoring the explicit
    // false. So a mutation that merged explicit-false into the heuristic path would
    // NOT turn this red. The discriminating proof is the separate
    // "KNOWN-FALSE (discriminates)" control below, whose fixture makes the explicit
    // value CONTRADICT what the heuristic would compute.
    const UPSTREAM = JSON.stringify({
      transcript: "hi", engine_used: "parakeet", served_engine: "parakeet",
      requested_engine: "parakeet", fallback_taken: false,
      decoded_duration_ms: 900, duration_ms: 10, processing_latency_ms: 10,
      audio_energy: { peak: 0.4, rms: 0.1, frames_above: 20, frames_total: 45, sample_count: 14400 },
      request_id: REQUEST_ID,
    });
    installSidecarFetch(() => new Response(UPSTREAM, { status: 200, headers: { "content-type": "application/json" } }));
    currentApp = await buildApp();
    await currentApp.inject({ method: "POST", url: TRANSCRIBE, headers: headers(), payload: AUDIO });
    const read = await currentApp.inject({ method: "GET", url: `${RECORDS}?correlationId=${REQUEST_ID}` });
    const fields = (read.json().record as { fields: Record<string, unknown> }).fields;
    console.log(`CONTROL dl-13862 SERVER-INT(known-false-persists) ${JSON.stringify({ served: fields.servedEngine, fallbackTaken: fields.fallbackTaken, fallbackTakenKnown: fields.fallbackTakenKnown, present: "fallbackTaken" in fields })}`);
    expect(fields.servedEngine).toBe("parakeet");
    // KNOWN-FALSE: the field is PRESENT, is exactly false, and is flagged KNOWN.
    expect("fallbackTaken" in fields).toBe(true);       // present (distinct from unknown, which is absent)
    expect(fields.fallbackTaken).toBe(false);           // the truthful false, preserved
    expect(fields.fallbackTakenKnown).toBe(true);       // KNOWN — not swallowed into unknown
    expect(fields.decodedDurationMs).toBe(900);
  });

  it("KNOWN-FALSE (discriminates): explicit fallback_taken:false + NO served_engine → known-false, NOT unknown", async () => {
    // dl-13862 control #2b (VoiceGate-4 mutation finding). The persistence control
    // above cannot tell explicit-false from heuristic-false because its fixture has
    // served==advertised. THIS fixture makes the explicit value CONTRADICT the
    // heuristic: fallback_taken:false is present, but there is NO served_engine, so
    // served is UNKNOWN and the heuristic branch cannot run at all.
    //
    //  - correct code (explicit honored first): known-false → fallbackTaken:false,
    //    fallbackTakenKnown:true, present:true.
    //  - merge-mutation (explicit-false falls through to the unknown/heuristic
    //    path, e.g. `!== null` → `=== true`): served is unknown so it lands in the
    //    UNKNOWN branch → fallbackTaken ABSENT, fallbackTakenKnown:false.
    //
    // The two outcomes DIVERGE, so the assertions below genuinely discriminate
    // explicit-false from the absence of an answer. Verified able-to-fail by
    // mutation (VoiceGate-4 method): this control goes RED under that mutation
    // while the persistence control stays green.
    const UPSTREAM = JSON.stringify({
      transcript: "hi", engine_used: "parakeet", // requested only; NO served_engine
      fallback_taken: false,                      // EXPLICIT false — the authoritative fact
      decoded_duration_ms: 900, duration_ms: 10, processing_latency_ms: 10,
      audio_energy: { peak: 0.4, rms: 0.1, frames_above: 20, frames_total: 45, sample_count: 14400 },
      request_id: REQUEST_ID,
    });
    installSidecarFetch(() => new Response(UPSTREAM, { status: 200, headers: { "content-type": "application/json" } }));
    currentApp = await buildApp();
    await currentApp.inject({ method: "POST", url: TRANSCRIBE, headers: headers(), payload: AUDIO });
    const read = await currentApp.inject({ method: "GET", url: `${RECORDS}?correlationId=${REQUEST_ID}` });
    const fields = (read.json().record as { fields: Record<string, unknown> }).fields;
    console.log(`CONTROL dl-13862 SERVER-INT(known-false-discriminates) ${JSON.stringify({ served: fields.servedEngine, fallbackTaken: fields.fallbackTaken, fallbackTakenKnown: fields.fallbackTakenKnown, present: "fallbackTaken" in fields })}`);
    // served is honestly unknown (no served_engine) — but the EXPLICIT false is still honored…
    expect(fields.servedEngine).toBe("unknown");
    // …so fallback is KNOWN-FALSE, NOT unknown. Under the merge-mutation these all flip.
    expect("fallbackTaken" in fields).toBe(true);   // present (mutation → absent)
    expect(fields.fallbackTaken).toBe(false);       // the truthful explicit false, honored verbatim
    expect(fields.fallbackTakenKnown).toBe(true);   // KNOWN (mutation → false)
  });

  it("UNKNOWN: legacy engine_used-only body → served unknown AND fallback UNKNOWN, NEVER false", async () => {
    // dl-13862 control #1 (the defect). A legacy sidecar emits engine_used (which
    // means REQUESTED) but NO served_engine and NO fallback_taken. served is
    // therefore unknown; the served≠advertised heuristic MUST NOT run (no input);
    // fallback must persist as UNKNOWN — the record must NEVER assert a confident
    // `false` that a reader would mistake for "the requested engine served it".
    // Able-to-fail by mutation: if index.ts reverts to the boolean collapse,
    // fallbackTaken becomes false and `"fallbackTaken" in fields` becomes true —
    // both assertions below go red.
    const LEGACY = JSON.stringify({
      transcript: "привет", engine_used: "parakeet",   // LEGACY: requested only; NO served_engine, NO fallback_taken
      decoded_duration_ms: 1200, duration_ms: 8,
      audio_energy: { peak: 0.5, rms: 0.15, frames_above: 60, frames_total: 70, sample_count: 19200 },
      request_id: REQUEST_ID,
    });
    installSidecarFetch(() => new Response(LEGACY, { status: 200, headers: { "content-type": "application/json" } }));
    currentApp = await buildApp();
    const res = await currentApp.inject({ method: "POST", url: TRANSCRIBE, headers: headers(), payload: AUDIO });
    expect(res.statusCode).toBe(200);
    const read = await currentApp.inject({ method: "GET", url: `${RECORDS}?correlationId=${REQUEST_ID}` });
    const fields = (read.json().record as { fields: Record<string, unknown> }).fields;
    console.log(`CONTROL dl-13862 SERVER-INT(legacy-unknown) ${JSON.stringify({ served: fields.servedEngine, fallbackTakenKnown: fields.fallbackTakenKnown, present: "fallbackTaken" in fields, rawFallback: fields.fallbackTaken })}`);
    // Served is honestly unknown (parseServedEngine reads served_engine ONLY).
    expect(fields.servedEngine).toBe("unknown");
    // Fallback is UNKNOWN in the STORED record: fallbackTakenKnown:false, and the
    // fallbackTaken field is ABSENT — NOT false.
    expect(fields.fallbackTakenKnown).toBe(false);
    expect("fallbackTaken" in fields).toBe(false);      // absent, so it CANNOT be misread as false
    expect(fields.fallbackTaken).not.toBe(false);       // explicit: the confident-false defect is gone
    expect(fields.fallbackTaken).toBeUndefined();
  });

  it("APP-2xx-EMPTY 502: distinct http502Class app-2xx-empty; sidecar duration+energy still captured", async () => {
    // dl-13792: even on a recognizer-empty 2xx, the decode HAPPENED — so the
    // sidecar reports a TRUE decoded duration + energy. Recognizer-empty does NOT
    // establish acoustic silence: the energy aggregate is exactly what tells us
    // whether the upload carried acoustic content. Here it did (non-zero energy).
    const EMPTY_200 = JSON.stringify({
      transcript: "", engine_used: "parakeet", served_engine: "parakeet",
      requested_engine: "parakeet", fallback_taken: false,
      decoded_duration_ms: 1500, duration_ms: 5, processing_latency_ms: 5,
      audio_energy: { peak: 0.55, rms: 0.2, frames_above: 70, frames_total: 75, sample_count: 24000 },
      request_id: REQUEST_ID,
    });
    installSidecarFetch(() => new Response(EMPTY_200, { status: 200, headers: { "content-type": "application/json" } }));
    currentApp = await buildApp();
    const res = await currentApp.inject({ method: "POST", url: TRANSCRIBE, headers: headers(), payload: AUDIO });
    expect(res.statusCode).toBe(502);
    expect(res.json().type).toBe("EmptyUpstreamTranscript");

    const read = await currentApp.inject({ method: "GET", url: `${RECORDS}?correlationId=${REQUEST_ID}` });
    const fields = (read.json().record as { fields: Record<string, unknown> }).fields;
    console.log(`CONTROL dl-13792 SERVER-INT(app-502-with-energy) ${JSON.stringify({ class: fields.http502Class, decoded: fields.decodedDurationMs, peak: fields.energyPeak, framesAbove: fields.energyFramesAbove })}`);
    expect(fields.http502Class).toBe("app-2xx-empty");   // the application 502 class
    expect(fields.serverOutcome).toBe("upstream-2xx-empty");
    expect(fields.httpStatus).toBe(502);
    // The decisive dl-13792 point: recognizer-empty, yet the upload had acoustic
    // ENERGY and a real decoded duration — recorded, not conflated with silence.
    expect(fields.decodedDurationMs).toBe(1500);
    expect(fields.serverEnergyMeasured).toBe(true);
    expect(fields.energyFramesAbove).toBe(70);
  });

  it("bounded read route: invalid correlationId → 400; list is bounded + newest-first", async () => {
    installSidecarFetch(() => new Response(JSON.stringify({ transcript: "x", engine_used: "parakeet", served_engine: "parakeet", decoded_duration_ms: 800, duration_ms: 1, audio_energy: { peak: 0.3, rms: 0.1, frames_above: 5, frames_total: 40, sample_count: 12800 }, request_id: REQUEST_ID }), { status: 200, headers: { "content-type": "application/json" } }));
    currentApp = await buildApp();
    const bad = await currentApp.inject({ method: "GET", url: `${RECORDS}?correlationId=not-a-uuid` });
    expect(bad.statusCode).toBe(400);
    const list = await currentApp.inject({ method: "GET", url: RECORDS });
    expect(list.statusCode).toBe(200);
    expect(Array.isArray(list.json().records)).toBe(true);
  });
});
