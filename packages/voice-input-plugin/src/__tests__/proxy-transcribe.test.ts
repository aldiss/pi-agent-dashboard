// @vitest-environment node
/**
 * Proxy contract tests for the voice-input plugin server registrar.
 *
 * Two layers:
 *   (A) PURE-HELPER units — sizeClass / sanitizeIdentity / inspectTranscriptEmptiness.
 *   (B) HANDLER integration — a REAL Fastify instance with the REAL register() wiring,
 *       driven via fastify.inject() (real routing + real multipart content-type parser +
 *       real handler). The ONLY substitution is global `fetch`, stubbed to stand in for
 *       the sidecar. This is the actual proxy code path, not a hand-rolled stand-in.
 *
 * Criteria exercised:
 *   2  — empty-200 (from a stale sidecar) is distinct from a forwarded typed failure.
 *   3  — telemetry carries phase/outcome/size-class/identity; NEVER transcript content;
 *        a forged newline in an identity header cannot split the log line.
 *   9  — DEFENSE-IN-DEPTH: the proxy itself never forwards a 2xx-empty (→ typed 502).
 *   10 — client bundle id + SW state are recorded from request headers, identity-only.
 *
 * Able-to-fail: see proxy-red-evidence — the criterion-9 defense test is proven RED by
 * deleting the inspectTranscriptEmptiness guard (forward respBody on 2xx unconditionally).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  register,
  sizeClass,
  sanitizeIdentity,
  inspectTranscriptEmptiness,
} from "../server/index.js";

// ── (A) PURE HELPERS ──────────────────────────────────────────────────────────

describe("sizeClass — coarse, non-reversible buckets", () => {
  it("buckets by magnitude and never echoes an exact length", () => {
    expect(sizeClass(0)).toBe("0");
    expect(sizeClass(66)).toBe("<1KiB");
    expect(sizeClass(1023)).toBe("<1KiB");
    expect(sizeClass(1024)).toBe("1-16KiB");
    expect(sizeClass(5000)).toBe("1-16KiB");
    expect(sizeClass(200_000)).toBe("16-256KiB");
    expect(sizeClass(2_000_000)).toBe("256KiB-4MiB");
    expect(sizeClass(9_000_000)).toBe(">=4MiB");
    expect(sizeClass(-5)).toBe("0");
    expect(sizeClass(NaN)).toBe("0");
  });
});

describe("sanitizeIdentity — log-injection-safe identity", () => {
  it("returns 'unknown' for missing / non-string / empty", () => {
    expect(sanitizeIdentity(undefined)).toBe("unknown");
    expect(sanitizeIdentity(null)).toBe("unknown");
    expect(sanitizeIdentity(123)).toBe("unknown");
    expect(sanitizeIdentity("")).toBe("unknown");
    expect(sanitizeIdentity("   ")).toBe("unknown");
  });
  it("passes a normal build hash through unchanged", () => {
    expect(sanitizeIdentity("index-DjFxsfzC")).toBe("index-DjFxsfzC");
  });
  it("strips CR/LF and control chars so a header cannot split a log line", () => {
    const forged = "abc\r\nvoice.telemetry phase=FORGED outcome=pwned";
    const out = sanitizeIdentity(forged);
    expect(out).not.toContain("\n");
    expect(out).not.toContain("\r");
    expect(out).not.toContain(" ");
  });
  it("caps length (bounded log field)", () => {
    expect(sanitizeIdentity("x".repeat(500)).length).toBeLessThanOrEqual(80);
  });
});

describe("inspectTranscriptEmptiness — 2xx-empty detector (defense-in-depth)", () => {
  it("accepts a schema-valid non-empty transcript", () => {
    expect(inspectTranscriptEmptiness(JSON.stringify({ transcript: "привет мир" }))).toEqual({ ok: true });
  });
  it("rejects empty / whitespace-only / missing / non-json", () => {
    expect(inspectTranscriptEmptiness(JSON.stringify({ transcript: "" }))).toEqual({ ok: false, reason: "empty-field" });
    expect(inspectTranscriptEmptiness(JSON.stringify({ transcript: "   " }))).toEqual({ ok: false, reason: "empty-field" });
    expect(inspectTranscriptEmptiness(JSON.stringify({ engine_used: "parakeet" }))).toEqual({ ok: false, reason: "missing-field" });
    expect(inspectTranscriptEmptiness("not json at all")).toEqual({ ok: false, reason: "non-json" });
  });
});

// ── (B) HANDLER INTEGRATION (real Fastify + inject; only fetch stubbed) ─────────

const TRANSCRIBE = "/api/plugins/voice-input/transcribe";

/** A configurable sidecar stand-in installed as global fetch. */
function installSidecarFetch(transcribeResponse: () => Response) {
  const stub = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/health")) {
      return new Response(JSON.stringify({ status: "ready" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return transcribeResponse();
  });
  globalThis.fetch = stub as unknown as typeof fetch;
  return stub;
}

/** Build a real Fastify app with the real register() + a telemetry spy. */
async function buildApp(): Promise<{ app: FastifyInstance; logs: string[] }> {
  const app = Fastify({ logger: false });
  const logs: string[] = [];
  // Production host uses logger:false. Capture the required console fallback,
  // not Fastify's present-but-no-op abstract logger.
  vi.spyOn(console, "info").mockImplementation((m: unknown) => {
    if (typeof m === "string") logs.push(m);
  });
  await register(app);
  // Let register()'s initial `void probeSidecar` resolve so sidecarHealthy=true.
  await new Promise((r) => setTimeout(r, 0));
  return { app, logs };
}

const AUDIO = Buffer.alloc(4096, 0x11); // >1KiB, past the client short-blob guard
const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";

let currentApp: FastifyInstance | null = null;
afterEach(async () => {
  if (currentApp) {
    await currentApp.close(); // clears the 5s health-poll interval via onClose
    currentApp = null;
  }
  vi.restoreAllMocks();
});

describe("proxy transcribe handler — real Fastify.inject", () => {
  it("forwards a valid non-empty transcript BYTE-IDENTICALLY (working path, criterion 4)", async () => {
    const UPSTREAM = JSON.stringify({ transcript: "привет мир", engine_used: "whisper", duration_ms: 1234 });
    installSidecarFetch(() => new Response(UPSTREAM, { status: 200, headers: { "content-type": "application/json" } }));
    const { app, logs } = await buildApp();
    currentApp = app;

    const res = await app.inject({
      method: "POST",
      url: TRANSCRIBE,
      headers: { "content-type": "audio/webm" },
      payload: AUDIO,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(UPSTREAM); // byte-identical — no re-serialisation
    expect(res.headers["content-type"]).toContain("application/json");
    expect(logs.some((l) => l.includes("phase=proxy-forward") && l.includes("outcome=ok"))).toBe(true);
    expect(logs.some((l) => l.includes("stopReason=unknown") && l.includes("correlationId=unknown"))).toBe(true);
  });

  it("CRITERION 9 (proxy defense): a stale-sidecar 200-EMPTY is converted to a typed 502, NOT forwarded", async () => {
    // The exact dl-12467 open-observable: a sidecar that still emits 200-empty.
    const EMPTY_200 = JSON.stringify({ transcript: "", engine_used: "parakeet", duration_ms: 5 });
    installSidecarFetch(() => new Response(EMPTY_200, { status: 200, headers: { "content-type": "application/json" } }));
    const { app, logs } = await buildApp();
    currentApp = app;

    const res = await app.inject({
      method: "POST",
      url: TRANSCRIBE,
      headers: { "content-type": "audio/webm" },
      payload: AUDIO,
    });

    expect(res.statusCode).toBe(502); // NEVER a 200-empty
    const body = res.json();
    expect(body.type).toBe("EmptyUpstreamTranscript");
    expect(body).not.toHaveProperty("transcript");
    const emptyLog = logs.find((l) => l.includes("outcome=upstream-2xx-empty"));
    expect(emptyLog).toContain("stopReason=unknown");
    expect(emptyLog).toContain("correlationId=unknown");
  });

  it("forwards a sidecar 422 no-speech failure VERBATIM (distinct typed state, criterion 2)", async () => {
    const NO_SPEECH = JSON.stringify({ error: "no recognisable speech", type: "EmptyTranscriptError", engines_tried: ["parakeet", "whisper"] });
    installSidecarFetch(() => new Response(NO_SPEECH, { status: 422, headers: { "content-type": "application/json" } }));
    const { app, logs } = await buildApp();
    currentApp = app;

    const res = await app.inject({
      method: "POST",
      url: TRANSCRIBE,
      headers: { "content-type": "audio/webm" },
      payload: AUDIO,
    });

    expect(res.statusCode).toBe(422); // forwarded, not swallowed
    expect(res.json().type).toBe("EmptyTranscriptError");
    const non2xxLog = logs.find((l) => l.includes("outcome=upstream-non-2xx"));
    expect(non2xxLog).toContain("stopReason=unknown");
    expect(non2xxLog).toContain("correlationId=unknown");
  });

  it("CRITERION 10 + 3: records client bundle + SW state, and a forged newline header cannot split the log", async () => {
    const UPSTREAM = JSON.stringify({ transcript: "hi", engine_used: "parakeet", duration_ms: 10 });
    installSidecarFetch(() => new Response(UPSTREAM, { status: 200, headers: { "content-type": "application/json" } }));
    const { app, logs } = await buildApp();
    currentApp = app;

    await app.inject({
      method: "POST",
      url: TRANSCRIBE,
      headers: {
        "content-type": "audio/webm",
        "x-voice-client-build": "index-DjFxsfzC",
        // a forged value trying to inject a second telemetry line:
        "x-voice-sw-state": "active\r\nvoice.telemetry phase=FORGED",
      },
      payload: AUDIO,
    });

    const forwardLine = logs.find((l) => l.includes("phase=proxy-forward"));
    expect(forwardLine).toBeTruthy();
    expect(forwardLine).toContain("clientBuild=index-DjFxsfzC");
    // The forged \r\n + space are stripped, collapsing the whole value into ONE
    // inert token — so it cannot (a) split into a second log line, nor (b) inject
    // a whitespace-delimited fake field. The `phase=FORGED` chars survive only as
    // a harmless substring INSIDE swState=, never as a parseable field of its own.
    expect(logs.length).toBe(1); // no forged second line
    expect(forwardLine).not.toContain("\n");
    expect(forwardLine).not.toContain("\r");
    expect(forwardLine).not.toContain(" phase=FORGED"); // not a delimited field
    expect(forwardLine).toContain("swState=activevoice.telemetryphase=FORGED"); // one inert token
  });

  it("records every allowed stop reason + RFC4122-v4 correlation on transcribe outcomes", async () => {
    const UPSTREAM = JSON.stringify({ transcript: "ok", engine_used: "parakeet", duration_ms: 10 });
    installSidecarFetch(() => new Response(UPSTREAM, { status: 200, headers: { "content-type": "application/json" } }));
    const { app, logs } = await buildApp();
    currentApp = app;

    for (const stopReason of ["manual-stop", "visibility-auto-stop", "safety-net-auto-stop"]) {
      const res = await app.inject({
        method: "POST",
        url: TRANSCRIBE,
        headers: {
          "content-type": "audio/webm",
          "x-voice-stop-reason": stopReason,
          "x-voice-request-id": REQUEST_ID,
        },
        payload: AUDIO,
      });

      expect(res.statusCode).toBe(200);
      expect(logs.some((line) =>
        line.includes("phase=proxy-forward")
        && line.includes(`stopReason=${stopReason}`)
        && line.includes(`correlationId=${REQUEST_ID}`)
      )).toBe(true);
    }
  });

  it("FAIL-OPEN invariant: malformed or half stop metadata is classified but never blocks upstream", async () => {
    const stub = installSidecarFetch(() => new Response(JSON.stringify({ transcript: "reachable" }), { status: 200 }));
    const { app, logs } = await buildApp();
    currentApp = app;

    const invalidReason = await app.inject({
      method: "POST",
      url: TRANSCRIBE,
      headers: {
        "content-type": "audio/webm",
        "x-voice-stop-reason": "backgrounded",
        "x-voice-request-id": REQUEST_ID,
      },
      payload: AUDIO,
    });
    const invalidId = await app.inject({
      method: "POST",
      url: TRANSCRIBE,
      headers: {
        "content-type": "audio/webm",
        "x-voice-stop-reason": "manual-stop",
        "x-voice-request-id": "not-a-uuid",
      },
      payload: AUDIO,
    });
    const wrongUuidVersion = await app.inject({
      method: "POST",
      url: TRANSCRIBE,
      headers: {
        "content-type": "audio/webm",
        "x-voice-stop-reason": "manual-stop",
        "x-voice-request-id": "123e4567-e89b-12d3-a456-426614174000",
      },
      payload: AUDIO,
    });
    const missingId = await app.inject({
      method: "POST",
      url: TRANSCRIBE,
      headers: {
        "content-type": "audio/webm",
        "x-voice-stop-reason": "manual-stop",
      },
      payload: AUDIO,
    });
    const missingReason = await app.inject({
      method: "POST",
      url: TRANSCRIBE,
      headers: {
        "content-type": "audio/webm",
        "x-voice-request-id": REQUEST_ID,
      },
      payload: AUDIO,
    });

    for (const response of [invalidReason, invalidId, wrongUuidVersion, missingId, missingReason]) {
      expect(response.statusCode).toBe(200);
      expect(response.json().transcript).toBe("reachable");
    }
    expect(stub.mock.calls.filter((call) => String(call[0]).includes("/transcribe"))).toHaveLength(5);
    const forwardLogs = logs.filter((line) => line.includes("phase=proxy-forward") && line.includes("outcome=ok"));
    expect(forwardLogs).toHaveLength(5);
    expect(forwardLogs.some((line) => line.includes("stopReason=invalid") && line.includes(`correlationId=${REQUEST_ID}`))).toBe(true);
    expect(forwardLogs.some((line) => line.includes("stopReason=manual-stop") && line.includes("correlationId=invalid"))).toBe(true);
    expect(forwardLogs.some((line) => line.includes("stopReason=manual-stop") && line.includes("correlationId=unknown"))).toBe(true);
    expect(forwardLogs.some((line) => line.includes("stopReason=unknown") && line.includes(`correlationId=${REQUEST_ID}`))).toBe(true);
  });

  it("logs legacy unknown stop metadata on proxy exceptions", async () => {
    const stub = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/health")) return new Response("{}", { status: 200 });
      throw new Error("synthetic upstream failure");
    });
    globalThis.fetch = stub as unknown as typeof fetch;
    const { app, logs } = await buildApp();
    currentApp = app;

    const res = await app.inject({ method: "POST", url: TRANSCRIBE, headers: { "content-type": "audio/webm" }, payload: AUDIO });

    expect(res.statusCode).toBe(502);
    const exceptionLog = logs.find((line) => line.includes("outcome=proxy-exception"));
    expect(exceptionLog).toContain("stopReason=unknown");
    expect(exceptionLog).toContain("correlationId=unknown");
  });

  it("PRIVACY (criterion 3): no telemetry line contains transcript content", async () => {
    const MARKER = "SUPERSECRETPROXYMARKER";
    const UPSTREAM = JSON.stringify({ transcript: MARKER, engine_used: "whisper", duration_ms: 7 });
    installSidecarFetch(() => new Response(UPSTREAM, { status: 200, headers: { "content-type": "application/json" } }));
    const { app, logs } = await buildApp();
    currentApp = app;

    await app.inject({ method: "POST", url: TRANSCRIBE, headers: { "content-type": "audio/webm" }, payload: AUDIO });

    expect(logs.join("\n")).not.toContain(MARKER);
    // but the body was still forwarded to the client byte-identically:
    // (assert via a fresh inject would double-call; the forward test above covers byte-identity)
    expect(logs.some((l) => l.includes("phase=proxy-forward"))).toBe(true);
  });

  it("health-gate: unhealthy sidecar → 503 with proxy-health-gate telemetry (no upstream POST)", async () => {
    // /health returns 503 so the initial probe leaves sidecarHealthy=false.
    const stub = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/health")) return new Response(JSON.stringify({ status: "loading" }), { status: 503 });
      return new Response(JSON.stringify({ transcript: "should-not-be-reached" }), { status: 200 });
    });
    globalThis.fetch = stub as unknown as typeof fetch;
    const app = Fastify({ logger: false });
    const consoleSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    await register(app);
    const logs: string[] = [];
    consoleSpy.mockImplementation((m: unknown) => {
      if (typeof m === "string") logs.push(m);
    });
    await new Promise((r) => setTimeout(r, 0));
    currentApp = app;

    const res = await app.inject({ method: "POST", url: TRANSCRIBE, headers: { "content-type": "audio/webm" }, payload: AUDIO });

    expect(res.statusCode).toBe(503);
    const gateLog = logs.find((l) => l.includes("phase=proxy-health-gate"));
    expect(gateLog).toContain("stopReason=unknown");
    expect(gateLog).toContain("correlationId=unknown");
    // upstream /transcribe must NOT have been POSTed (only /health probes):
    const transcribePosts = stub.mock.calls.filter((c) => String(c[0]).includes("/transcribe"));
    expect(transcribePosts.length).toBe(0);
  });
});

// ── /telemetry endpoint (T2/T3): privacy-safe pre-POST phase sink ────────────────

const TELEMETRY = "/api/plugins/voice-input/telemetry";

describe("proxy /telemetry — privacy-safe phase sink (T2/T3)", () => {
  it("accepts a valid allowlisted envelope → 204 + a privacy-safe log line", async () => {
    installSidecarFetch(() => new Response(JSON.stringify({ transcript: "x" }), { status: 200 }));
    const { app, logs } = await buildApp();
    currentApp = app;

    const res = await app.inject({
      method: "POST",
      url: TELEMETRY,
      headers: {
        "content-type": "application/json",
        "x-voice-client-build": "BQDQWBow",
        "x-voice-sw-state": "reg:active:activated;ctrl:activated",
      },
      payload: JSON.stringify({ phase: "pre-post", outcome: "short-blob", sizeClass: "<1KiB" }),
    });

    expect(res.statusCode).toBe(204);
    const line = logs.find((l) => l.includes("phase=client-pre-post"));
    expect(line, "a telemetry line was emitted").toBeTruthy();
    expect(line).toContain("outcome=short-blob");
    expect(line).toContain("bodySizeClass=<1KiB");
    expect(line).toContain("clientBuild=BQDQWBow");
  });

  it("REJECTS a non-allowlisted outcome → 400 (a free-form field cannot smuggle content)", async () => {
    installSidecarFetch(() => new Response(JSON.stringify({ transcript: "x" }), { status: 200 }));
    const { app } = await buildApp();
    currentApp = app;

    // A would-be content smuggle in `outcome` — not on the allowlist → 400.
    const res = await app.inject({
      method: "POST",
      url: TELEMETRY,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ phase: "pre-post", outcome: "the operator said hello world", sizeClass: "<1KiB" }),
    });
    expect(res.statusCode).toBe(400);
  });

  it("accepts every recording-stopped enum token with RFC4122-v4 ID and logs both", async () => {
    installSidecarFetch(() => new Response(JSON.stringify({ transcript: "x" }), { status: 200 }));
    const { app, logs } = await buildApp();
    currentApp = app;

    for (const stopReason of ["manual-stop", "visibility-auto-stop", "safety-net-auto-stop"]) {
      const res = await app.inject({
        method: "POST",
        url: TELEMETRY,
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({
          phase: "client",
          outcome: "recording-stopped",
          sizeClass: "1-16KiB",
          stopReason,
          requestId: REQUEST_ID,
        }),
      });

      expect(res.statusCode).toBe(204);
      expect(logs.some((line) =>
        line.includes("outcome=recording-stopped")
        && line.includes(`stopReason=${stopReason}`)
        && line.includes(`correlationId=${REQUEST_ID}`)
      )).toBe(true);
    }
  });

  it("rejects incomplete/invalid recording-stopped envelopes and stop fields on other outcomes", async () => {
    installSidecarFetch(() => new Response(JSON.stringify({ transcript: "x" }), { status: 200 }));
    const { app } = await buildApp();
    currentApp = app;
    const envelopes = [
      { phase: "client", outcome: "recording-stopped", sizeClass: "1-16KiB", stopReason: "manual-stop" },
      { phase: "client", outcome: "recording-stopped", sizeClass: "1-16KiB", requestId: REQUEST_ID },
      { phase: "client", outcome: "recording-stopped", sizeClass: "1-16KiB", stopReason: "bad", requestId: REQUEST_ID },
      { phase: "client", outcome: "recording-stopped", sizeClass: "1-16KiB", stopReason: "manual-stop", requestId: "bad" },
      { phase: "pre-post", outcome: "recording-stopped", sizeClass: "1-16KiB", stopReason: "manual-stop", requestId: REQUEST_ID },
      { phase: "client", outcome: "no-speech", sizeClass: "1-16KiB", stopReason: "manual-stop", requestId: REQUEST_ID },
    ];

    for (const payload of envelopes) {
      const res = await app.inject({
        method: "POST",
        url: TELEMETRY,
        headers: { "content-type": "application/json" },
        payload: JSON.stringify(payload),
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it("REJECTS a raw byte-count masquerading as a sizeClass → 400 (no exact-size side channel)", async () => {
    installSidecarFetch(() => new Response(JSON.stringify({ transcript: "x" }), { status: 200 }));
    const { app } = await buildApp();
    currentApp = app;

    const res = await app.inject({
      method: "POST",
      url: TELEMETRY,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ phase: "pre-post", outcome: "short-blob", sizeClass: "512" }),
    });
    expect(res.statusCode).toBe(400); // "512" is not an allowlisted bucket token
  });

  it("never logs transcript/audio content (only fixed tokens reach the log)", async () => {
    installSidecarFetch(() => new Response(JSON.stringify({ transcript: "x" }), { status: 200 }));
    const { app, logs } = await buildApp();
    currentApp = app;

    await app.inject({
      method: "POST",
      url: TELEMETRY,
      headers: { "content-type": "application/json" },
      // Even if a client tried to add extra fields, only allowlisted tokens are logged.
      payload: JSON.stringify({ phase: "client", outcome: "no-speech", sizeClass: "1-16KiB", transcript: "LEAKMARKER", audio: "AUDIOMARKER" }),
    });

    const all = logs.join("\n");
    expect(all).not.toContain("LEAKMARKER");
    expect(all).not.toContain("AUDIOMARKER");
    expect(all.includes("phase=client-client") && all.includes("outcome=no-speech")).toBe(true);
  });
});
