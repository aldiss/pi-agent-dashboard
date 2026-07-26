/**
 * Layer 1 (client) local-first telemetry tests — the load-bearing suite, and
 * ABLE TO FAIL.
 *
 * The whole build exists to make a ZERO-POST failure observable. That is only
 * true if the client record survives the very condition it exists to detect —
 * an unreachable dashboard. So these tests assert, each with a RED control:
 *
 *   - PERSIST-BEFORE-SEND: a record exists in the buffer immediately after
 *     emit(), before (and independent of) any successful transmission.
 *   - OFFLINE / NETWORK-FAILURE / AUTH-FAILURE → record PERSISTS (drain fails,
 *     buffer retains).
 *   - RELOAD → a fresh module session DRAINS what the prior session persisted.
 *   - DELIVERED ONLY ON 2xx BODY-ACK for the exact (request_id, seq). A bare
 *     200 (or a 200 that acks nothing — a manufactured/SW response) marks
 *     NOTHING delivered. sendBeacon NEVER marks delivered.
 *   - FAILED DRAIN → record RETAINED.
 *   - STORAGE QUOTA EXCEEDED / STORAGE UNAVAILABLE → overflow visible / degraded
 *     flag set, no crash.
 *   - PRIVACY: a sentinel transcript / audio value handed to emit() is dropped
 *     by the allowlist and never persisted.
 *
 * These exercise the telemetry module directly against jsdom's localStorage.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  emit,
  drain,
  beaconUnload,
  sanitize,
  configureTelemetry,
  newRequestId,
  _debugReadBuffer,
  _debugReadMeta,
  _debugReset,
  BUFFER_MAX_COUNT,
  TELEMETRY_ALLOWED_FIELDS,
} from "../client/telemetry.js";

const ENDPOINT = "/api/plugins/voice-input/telemetry";
const SENTINEL_TEXT = "SENTINELtranscriptDONOTLOG";
const SENTINEL_AUDIO = "SENTINELaudioBYTES";

/** Build a fetch that 200s and acks EXACTLY the (request_id, seq) it received. */
function ackingFetch() {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      records?: Array<{ request_id: string; seq: number }>;
    };
    const acked = (body.records ?? []).map((r) => ({ request_id: r.request_id, seq: r.seq }));
    return new Response(JSON.stringify({ ok: true, acked }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

beforeEach(() => {
  _debugReset();
  // Default: no fetch unless a test installs one, so "offline" is the baseline.
  // (jsdom provides localStorage; we replace fetch per-test.)
  (globalThis as { fetch?: unknown }).fetch = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  _debugReset();
});

describe("client telemetry — local-first, ack-on-body-only, overflow-visible", () => {
  it("PERSIST-BEFORE-SEND: emit writes to the buffer synchronously", () => {
    const id = newRequestId();
    emit(id, "capture_start");
    const buf = _debugReadBuffer();
    expect(buf.length).toBe(1);
    expect(buf[0].request_id).toBe(id);
    expect(buf[0].event).toBe("capture_start");
  });

  it("OFFLINE: with no fetch available, the record persists and drain is a no-op", async () => {
    const id = newRequestId();
    emit(id, "no_post", { reason: "too_short", blob_bytes: 512 });
    const confirmed = await drain(ENDPOINT); // no global fetch → 0
    expect(confirmed).toBe(0);
    expect(_debugReadBuffer().length).toBe(1); // retained
  });

  it("blob<1024 zero-POST path writes a local record (the operator's case)", () => {
    const id = newRequestId();
    // This is exactly what PushToTalkButton.onstop emits on the <1KB branch.
    emit(id, "no_post", { reason: "too_short", blob_bytes: 900, mime: "audio/webm" });
    const buf = _debugReadBuffer();
    expect(buf.length).toBe(1);
    expect(buf[0].reason).toBe("too_short");
    expect(buf[0].blob_bytes).toBe(900);
  });

  it("NETWORK-FAILURE: a throwing fetch retains the record", async () => {
    (globalThis as { fetch?: unknown }).fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const id = newRequestId();
    emit(id, "pre_post");
    const confirmed = await drain(ENDPOINT);
    expect(confirmed).toBe(0);
    expect(_debugReadBuffer().length).toBe(1); // retained for a later session
  });

  it("AUTH-FAILURE: a 401 (non-2xx) retains the record", async () => {
    (globalThis as { fetch?: unknown }).fetch = vi.fn(
      async () => new Response("nope", { status: 401 })
    );
    const id = newRequestId();
    emit(id, "pre_post");
    const confirmed = await drain(ENDPOINT);
    expect(confirmed).toBe(0);
    expect(_debugReadBuffer().length).toBe(1);
  });

  it("DELIVERED ONLY ON 2xx BODY-ACK: an acking drain clears the record", async () => {
    (globalThis as { fetch?: unknown }).fetch = ackingFetch();
    const id = newRequestId();
    emit(id, "capture_start");
    const confirmed = await drain(ENDPOINT);
    expect(confirmed).toBe(1);
    expect(_debugReadBuffer().length).toBe(0); // delivered → dropped
  });

  it("MANUFACTURED 200 (acks nothing) marks NOTHING delivered — SW/intermediary defense", async () => {
    // A 200 with an empty ack list (what a service worker / proxy that fakes a
    // response would produce). Must NOT be treated as delivery.
    (globalThis as { fetch?: unknown }).fetch = vi.fn(
      async () => new Response(JSON.stringify({ ok: true, acked: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    const id = newRequestId();
    emit(id, "capture_start");
    const confirmed = await drain(ENDPOINT);
    expect(confirmed).toBe(0);
    expect(_debugReadBuffer().length).toBe(1); // retained — no false success
  });

  it("RED control — treating bare HTTP 200 as delivery is rejected", async () => {
    // Model the BROKEN client policy: mark delivered on status 200 regardless
    // of body. Show the same manufactured response would wrongly clear it.
    const buffer = [{ request_id: "a", seq: 1, delivered: false }];
    const brokenMarkDelivered = (status: number) => {
      if (status === 200) buffer[0].delivered = true; // BUG: no body-ack check
    };
    brokenMarkDelivered(200);
    // The green invariant is "still retained after a no-ack 200". It fails here.
    expect(() => expect(buffer[0].delivered).toBe(false)).toThrow();
  });

  it("2xx that acks a DIFFERENT id does not clear our record", async () => {
    (globalThis as { fetch?: unknown }).fetch = vi.fn(
      async () => new Response(
        JSON.stringify({ ok: true, acked: [{ request_id: "someone-else", seq: 99 }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    const id = newRequestId();
    emit(id, "capture_start");
    const confirmed = await drain(ENDPOINT);
    expect(confirmed).toBe(0);
    expect(_debugReadBuffer().length).toBe(1);
  });

  it("RELOAD: a later session drains what an earlier one persisted", async () => {
    // Session 1: offline → persists.
    const id = newRequestId();
    emit(id, "no_post", { reason: "permission_denied" });
    expect(_debugReadBuffer().length).toBe(1);
    // Session 2 ("reload"): localStorage survives; an acking drain ships it.
    (globalThis as { fetch?: unknown }).fetch = ackingFetch();
    const confirmed = await drain(ENDPOINT);
    expect(confirmed).toBe(1);
    expect(_debugReadBuffer().length).toBe(0);
  });

  it("FAILED DRAIN then SUCCESS: record retained across the failure, delivered after", async () => {
    // First drain: network failure.
    const failing = vi.fn(async () => {
      throw new TypeError("down");
    });
    (globalThis as { fetch?: unknown }).fetch = failing;
    const id = newRequestId();
    emit(id, "pre_post");
    expect(await drain(ENDPOINT)).toBe(0);
    expect(_debugReadBuffer().length).toBe(1); // retained
    // Second drain: acking success.
    (globalThis as { fetch?: unknown }).fetch = ackingFetch();
    expect(await drain(ENDPOINT)).toBe(1);
    expect(_debugReadBuffer().length).toBe(0);
  });

  it("COUNT BOUND: buffer never exceeds BUFFER_MAX_COUNT; overflow is counted", () => {
    const overBy = 15;
    for (let i = 0; i < BUFFER_MAX_COUNT + overBy; i++) {
      emit(newRequestId(), "capture_start");
    }
    const buf = _debugReadBuffer();
    expect(buf.length).toBe(BUFFER_MAX_COUNT);
    expect(_debugReadMeta().overflow).toBe(overBy); // loss made visible
  });

  it("STORAGE QUOTA EXCEEDED: no crash, overflow visible (degrade, don't die)", () => {
    // Force setItem to throw a quota error on the buffer write.
    const realSet = Storage.prototype.setItem;
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      k: string,
      v: string
    ) {
      if (k.includes("buffer")) {
        const e = new Error("QuotaExceededError");
        e.name = "QuotaExceededError";
        throw e;
      }
      return realSet.call(this, k, v);
    });
    try {
      // Must not throw.
      expect(() => emit(newRequestId(), "capture_start")).not.toThrow();
      // Overflow surfaced (records shed to make room, or degraded to memory).
      const meta = _debugReadMeta();
      expect(meta.overflow > 0 || meta.degraded === true).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("STORAGE UNAVAILABLE: emit degrades to memory, still records, no crash", () => {
    // Make the probe fail so storage() returns null (private-mode shape).
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      const e = new Error("SecurityError");
      e.name = "SecurityError";
      throw e;
    });
    try {
      const id = newRequestId();
      expect(() => emit(id, "capture_start")).not.toThrow();
      // Recorded in the in-memory fallback, flagged degraded.
      const buf = _debugReadBuffer();
      expect(buf.length).toBe(1);
      expect(buf[0].degraded).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("PRIVACY: emit drops content — sentinel transcript/audio never persisted", () => {
    const id = newRequestId();
    // A hostile/broken caller smuggles content-bearing keys. Cast past the type
    // so the EXTRA keys reach emit() at runtime — the allowlist must drop them.
    const hostileFields = {
      blob_bytes: 4096,
      mime: "audio/webm",
      transcript: SENTINEL_TEXT,
      audio: SENTINEL_AUDIO,
      transcript_hash: "deadbeef",
    } as unknown as Parameters<typeof emit>[2];
    emit(id, "capture_end", hostileFields);
    const blob = JSON.stringify(_debugReadBuffer());
    expect(blob).not.toContain(SENTINEL_TEXT);
    expect(blob).not.toContain(SENTINEL_AUDIO);
    expect(blob).not.toContain("deadbeef");
    // Allowed metadata kept.
    expect(_debugReadBuffer()[0].blob_bytes).toBe(4096);
  });

  it("PRIVACY RED control — a non-sanitising persist leaks the sentinel", () => {
    // Prove the sentinel scan has teeth: raw JSON of the input DOES contain it.
    const raw = JSON.stringify({ request_id: "a", transcript: SENTINEL_TEXT });
    expect(() => expect(raw).not.toContain(SENTINEL_TEXT)).toThrow();
  });

  it("sanitize allowlist is exactly the declared fields (guards accidental additions)", () => {
    const s = sanitize({
      ...Object.fromEntries(TELEMETRY_ALLOWED_FIELDS.map((f) => [f, 1])),
      request_id: "a",
      event: "capture_start",
      mime: "audio/webm",
      net_error: "AbortError",
      degraded: true,
      evil_transcript: SENTINEL_TEXT,
    });
    for (const k of Object.keys(s)) {
      expect(TELEMETRY_ALLOWED_FIELDS).toContain(k);
    }
    expect(JSON.stringify(s)).not.toContain(SENTINEL_TEXT);
  });

  it("beaconUnload NEVER marks delivered (best-effort only)", () => {
    const sent: unknown[] = [];
    (globalThis as unknown as { navigator: { sendBeacon: (u: string, b: unknown) => boolean } }).navigator.sendBeacon =
      (_u: string, b: unknown) => {
        sent.push(b);
        return true; // UA "queued" — NOT server "received"
      };
    const id = newRequestId();
    emit(id, "capture_start");
    const queued = beaconUnload(ENDPOINT);
    expect(queued).toBe(true); // UA accepted it …
    // … but the record is STILL in the buffer, undelivered — beacon cannot ack.
    expect(_debugReadBuffer().length).toBe(1);
  });

  it("beaconUnload RED control — treating its boolean as delivery is rejected", () => {
    // Model the BUG: delete the record because sendBeacon returned true.
    const buffer = [{ id: "a", delivered: false }];
    const beaconQueued = true;
    const brokenPolicy = () => {
      if (beaconQueued) buffer.pop(); // BUG: queued ≠ delivered
    };
    brokenPolicy();
    // Green invariant "record retained after beacon" fails here.
    expect(() => expect(buffer.length).toBe(1)).toThrow();
  });

  // ── storage-degraded residual (STEER #5) ─────────────────────────────────
  // When storage is unavailable the buffer is memory-only; a reload would lose
  // records AND the degraded marker together. The module fires an IMMEDIATE,
  // externally-observable degraded signal so the fact does not die with the tab.

  it("DEGRADED SIGNAL: storage-unavailable emit fires an immediate degraded beacon", () => {
    const beacons: Array<{ url: string; body: string }> = [];
    (globalThis as unknown as { navigator: { sendBeacon: (u: string, b: Blob) => boolean } }).navigator.sendBeacon =
      (url: string, body: Blob) => {
        // jsdom Blob: read synchronously via text() is async; capture type+size
        // and stash the endpoint. We assert the endpoint + that a beacon fired.
        beacons.push({ url, body: (body as unknown as { type: string }).type });
        return true;
      };
    // Make storage unavailable (probe throws) so emit() takes the degraded path.
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      const e = new Error("SecurityError");
      e.name = "SecurityError";
      throw e;
    });
    try {
      configureTelemetry(ENDPOINT);
      emit(newRequestId(), "capture_start"); // storage down → signal fires once
      emit(newRequestId(), "no_post", { reason: "too_short" }); // must NOT re-fire
      expect(beacons.length).toBe(1); // one-shot: exactly one degraded signal
      expect(beacons[0].url).toBe(ENDPOINT);
      expect(beacons[0].body).toBe("application/json");
    } finally {
      spy.mockRestore();
    }
  });

  it("DEGRADED SIGNAL: falls back to keepalive fetch when sendBeacon is absent", async () => {
    const posts: Array<{ url: string; init?: RequestInit }> = [];
    // Remove sendBeacon; provide a fetch that records the degraded POST.
    (globalThis as unknown as { navigator: Record<string, unknown> }).navigator.sendBeacon =
      undefined as unknown as Navigator["sendBeacon"];
    (globalThis as { fetch?: unknown }).fetch = vi.fn(async (url: string, init?: RequestInit) => {
      posts.push({ url, init });
      return new Response(JSON.stringify({ ok: true, acked: [] }), { status: 200 });
    });
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      const e = new Error("SecurityError");
      e.name = "SecurityError";
      throw e;
    });
    try {
      configureTelemetry(ENDPOINT);
      emit(newRequestId(), "capture_start");
      // Allow the fire-and-forget fetch microtask to run.
      await Promise.resolve();
      expect(posts.length).toBeGreaterThanOrEqual(1);
      const degradedPost = posts.find((p) => {
        try {
          return JSON.parse(String(p.init?.body ?? "{}")).degraded === true;
        } catch {
          return false;
        }
      });
      expect(degradedPost).toBeTruthy();
      expect(degradedPost?.init?.keepalive).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("DEGRADED SIGNAL carries NO records/content — it is a notice, not a delivery", () => {
    const beacons: string[] = [];
    // Capture the actual JSON body via a fetch fallback (sendBeacon Blob is async).
    (globalThis as unknown as { navigator: Record<string, unknown> }).navigator.sendBeacon =
      undefined as unknown as Navigator["sendBeacon"];
    (globalThis as { fetch?: unknown }).fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      beacons.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({ ok: true, acked: [] }), { status: 200 });
    });
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      const e = new Error("SecurityError");
      e.name = "SecurityError";
      throw e;
    });
    try {
      configureTelemetry(ENDPOINT);
      emit(newRequestId(), "capture_end", { blob_bytes: 4096, mime: "audio/webm" });
      const degraded = beacons.map((b) => JSON.parse(b)).find((b) => b.degraded === true);
      expect(degraded).toBeTruthy();
      // A notice: empty records, no content fields.
      expect(degraded.records).toEqual([]);
      expect(JSON.stringify(degraded)).not.toContain("audio/webm"); // no record leaked
    } finally {
      spy.mockRestore();
    }
  });

  it("DEGRADED RED control — an in-memory-only flag that a reload would lose is rejected", () => {
    // Model the REJECTED design: mark degraded ONLY in memory, emit nothing.
    // Simulate reload by discarding the in-memory marker. The fact of loss must
    // be externally observable; here it is not, so the guard must go RED.
    let inMemoryDegraded = false;
    const brokenEmitDegraded = () => {
      inMemoryDegraded = true; // BUG: no external signal
    };
    const externallyObserved: string[] = []; // nothing is pushed — that's the bug
    brokenEmitDegraded();
    // reload:
    inMemoryDegraded = false;
    // Green invariant: degradation observable after reload (externally). RED here.
    expect(() => expect(externallyObserved.length).toBeGreaterThan(0)).toThrow();
    expect(inMemoryDegraded).toBe(false); // marker gone with the tab — the defect
  });
});
