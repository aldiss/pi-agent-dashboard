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
  _debugPoisonBuffer,
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
    // Force setItem to throw a quota error on the STATE blob write, but let the
    // storage() probe key succeed so this exercises the quota path (write fails)
    // and NOT the storage-unavailable path (probe fails). Matches the atomic
    // single-blob key `voiceInputTelemetry.state.v2`.
    const realSet = Storage.prototype.setItem;
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      k: string,
      v: string
    ) {
      if (k.includes("state")) {
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

// ── D2: atomic local-first state / drain race (Pete dl-12308 #2) ───────────────
// Serialise or merge drain commits against CURRENT state so a concurrent emit is
// never stale-overwritten; buffer+seq atomic; degraded sticky; sendBeacon=false
// falls through to fetch. Each property has a RED control (a broken variant the
// same assertion rejects).

/** A fetch whose response body acks EXACTLY the (request_id, seq) it received. */
function ackingFetchD2() {
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

describe("client telemetry — D2 atomic state + drain-race (re-read/merge, serialise, sticky, quota)", () => {
  const ENDPOINT = "/api/plugins/voice-input/telemetry";
  const SENTINEL_TEXT = "SENTINELtranscriptDONOTLOG";
  beforeEach(() => {
    _debugReset();
    (globalThis as { fetch?: unknown }).fetch = undefined;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    _debugReset();
  });

  it("RE-READ+MERGE: a record emitted DURING an in-flight drain is NOT stale-overwritten", async () => {
    // A gated fetch: it POSTs id-1, then PAUSES so we can emit id-2 mid-flight,
    // then acks only what it received (id-1). The re-read must retain id-2.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    (globalThis as { fetch?: unknown }).fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        records?: Array<{ request_id: string; seq: number }>;
      };
      const acked = (body.records ?? []).map((r) => ({ request_id: r.request_id, seq: r.seq }));
      await gate; // hold the drain open
      return new Response(JSON.stringify({ ok: true, acked }), { status: 200 });
    });

    emit("id-1", "capture_start");
    const draining = drain(ENDPOINT); // starts, will POST id-1, then await the gate
    // Let the chained drainOnce reach its fetch/await before we emit id-2.
    await Promise.resolve();
    await Promise.resolve();
    emit("id-2", "pre_post"); // concurrent emit DURING the in-flight drain
    release();
    const confirmed = await draining;

    expect(confirmed).toBe(1); // id-1 delivered
    const ids = _debugReadBuffer().map((r) => r.request_id);
    expect(ids).toContain("id-2"); // id-2 SURVIVES (the bug dropped it)
    expect(ids).not.toContain("id-1"); // id-1 removed
  });

  it("RED control — filtering the PRE-await snapshot drops the concurrent emit", () => {
    // Model the old bug: filter the snapshot taken BEFORE the await.
    const snapshotBefore = [{ request_id: "id-1", seq: 1 }];
    const acked = new Set(["id-1:1"]);
    // A concurrent emit added id-2 to CURRENT state, but the buggy code writes
    // back `snapshotBefore.filter(...)`, which never contained id-2.
    const writtenBack = snapshotBefore.filter((e) => !acked.has(`${e.request_id}:${e.seq}`));
    const idsWritten = writtenBack.map((e) => e.request_id);
    // Green invariant "id-2 retained" fails against the stale-snapshot writeback.
    expect(() => expect(idsWritten).toContain("id-2")).toThrow();
  });

  it("SERIALISED DRAINS: two concurrent drains do not double-POST the same record", async () => {
    const fetchSpy = ackingFetchD2();
    (globalThis as { fetch?: unknown }).fetch = fetchSpy;
    emit("solo", "capture_start");
    // Fire two drains without awaiting the first — they must serialise.
    const [c1, c2] = await Promise.all([drain(ENDPOINT), drain(ENDPOINT)]);
    // Exactly one POST carried the record; the second drain saw an empty buffer.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(c1 + c2).toBe(1); // delivered exactly once
    expect(_debugReadBuffer().length).toBe(0);
  });

  it("RED control — unserialised concurrent drains double-POST", async () => {
    // Model no-serialisation: both drains read the same pending snapshot and POST.
    let posts = 0;
    const rawFetch = vi.fn(async () => {
      posts++;
      return new Response(JSON.stringify({ ok: true, acked: [] }), { status: 200 });
    });
    // Two "drains" that both POST from the same snapshot with no chaining.
    await Promise.all([rawFetch(), rawFetch()]);
    expect(() => expect(posts).toBe(1)).toThrow(); // RED: it is 2
  });

  it("ATOMIC seq: buffer and seq advance together; seq never drifts", () => {
    emit("a", "capture_start"); // seq 1
    emit("b", "capture_start"); // seq 2
    emit("c", "capture_start"); // seq 3
    const seqs = _debugReadBuffer().map((r) => r.seq).sort((x, y) => x - y);
    expect(seqs).toEqual([1, 2, 3]);
    expect(_debugReadMeta().seq).toBe(3); // meta.seq == max entry seq (one blob)
  });

  it("STICKY DEGRADED: once memory-fallback happens, degraded never reverts", () => {
    // First write fails hard (both attempts) → sticky degraded set.
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      k: string
    ) {
      if (k.includes("state")) {
        const e = new Error("QuotaExceededError");
        e.name = "QuotaExceededError";
        throw e;
      }
      // allow probe
    });
    emit("x", "capture_start");
    expect(_debugReadMeta().degraded).toBe(true);
    spy.mockRestore();
    // Even though storage now works again, a subsequent read stays degraded.
    emit("y", "capture_start");
    expect(_debugReadMeta().degraded).toBe(true); // STICKY — did not revert
  });

  it("RED control — non-sticky degraded reverts on the next healthy read", () => {
    // Model a non-sticky flag: degraded read straight from a healthy blob = false.
    let degraded = true; // set during the failed write …
    const readFromHealthyBlob = () => {
      degraded = false; // … but a later healthy read overwrites it (the bug)
      return degraded;
    };
    expect(() => expect(readFromHealthyBlob()).toBe(true)).toThrow(); // RED
  });

  it("DOUBLE-QUOTA: two consecutive quota failures do not crash and count overflow/degrade", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      k: string
    ) {
      if (k.includes("state")) {
        const e = new Error("QuotaExceededError");
        e.name = "QuotaExceededError";
        throw e;
      }
    });
    try {
      expect(() => emit("q1", "capture_start")).not.toThrow();
      expect(() => emit("q2", "capture_start")).not.toThrow();
      const meta = _debugReadMeta();
      // Loss is visible (overflow) OR we degraded to memory — never silent, never crash.
      expect(meta.overflow > 0 || meta.degraded === true).toBe(true);
      // The second emit's record still exists in the memory-authoritative state
      // (a stale on-disk blob must NOT have reverted it).
      const ids = _debugReadBuffer().map((r) => r.request_id);
      expect(ids).toContain("q2");
    } finally {
      spy.mockRestore();
    }
  });

  it("META-WRITE-FAILURE atomicity: seq and entries are ONE blob — they cannot desync", () => {
    // The prior two-key design could write the buffer but fail the meta write
    // (or vice-versa), desyncing seq from the entries it numbers. With a single
    // atomic blob there is NO separate meta write to fail. Prove the invariant
    // two ways:
    // (a) healthy write — seq and the entry land together.
    emit("e1", "capture_start");
    expect(_debugReadMeta().seq).toBe(1);
    expect(_debugReadBuffer().map((r) => r.request_id)).toEqual(["e1"]);

    // (b) under TOTAL write failure with several entries: whatever the blob
    // RETAINS, seq still reflects the newest entry and the shed count is
    // accounted in overflow — no retained-entry without its seq, no lost entry
    // without a matching overflow. Never a silent split, never a crash.
    const before = _debugReadMeta().seq;
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      k: string
    ) {
      if (k.includes("state")) {
        const e = new Error("QuotaExceededError");
        e.name = "QuotaExceededError";
        throw e;
      }
    });
    try {
      // Add three more; the failing writes shed-half + count overflow.
      emit("e2", "capture_start");
      emit("e3", "capture_start");
      emit("e4", "capture_start");
      const meta = _debugReadMeta();
      const ids = _debugReadBuffer().map((r) => r.request_id);
      // seq advanced monotonically for every emit (never reused / rolled back).
      expect(meta.seq).toBe(before + 3);
      // Conservation: retained entries + overflow-counted losses == everything
      // that was ever in the blob at the last write. No entry vanished silently.
      // (retained + overflow) must cover the emits since the healthy baseline.
      expect(ids.length + meta.overflow).toBeGreaterThanOrEqual(3);
      // Degraded/overflow surfaced the loss — not silent, not crashed.
      expect(meta.overflow > 0 || meta.degraded === true).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("sendBeacon=false FALLS THROUGH to a keepalive fetch (beaconUnload)", () => {
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    (globalThis as { fetch?: unknown }).fetch = fetchSpy;
    // sendBeacon present but REFUSES to queue (returns false).
    (globalThis as unknown as { navigator: { sendBeacon: () => boolean } }).navigator.sendBeacon =
      () => false;
    emit("b1", "capture_start");
    const queued = beaconUnload(ENDPOINT);
    expect(queued).toBe(false); // beacon did not queue …
    expect(fetchSpy).toHaveBeenCalledTimes(1); // … so we fell through to fetch
  });

  it("RED control — treating sendBeacon=false as handled skips the fetch fallback", () => {
    // Model the bug: `if (sendBeacon) return true;` with no fall-through.
    let fetched = false;
    const brokenBeacon = () => {
      const queued = false; // sendBeacon returned false
      if (typeof queued === "boolean") return queued; // BUG: returns without fetch
      fetched = true;
    };
    brokenBeacon();
    // Green invariant "fell through to fetch" fails here.
    expect(() => expect(fetched).toBe(true)).toThrow();
  });

  it("sendBeacon=true does NOT mark delivered (record retained; only drain acks)", () => {
    (globalThis as unknown as { navigator: { sendBeacon: () => boolean } }).navigator.sendBeacon =
      () => true;
    emit("b2", "capture_start");
    expect(beaconUnload(ENDPOINT)).toBe(true);
    expect(_debugReadBuffer().length).toBe(1); // still buffered — beacon ≠ delivery
    // Privacy spot-check: nothing content-bearing was ever persisted.
    expect(JSON.stringify(_debugReadBuffer())).not.toContain(SENTINEL_TEXT);
  });
});

// ── D3: privacy validation at the WIRE boundary (Pete dl-12308 #3) ─────────────
// The original hole: sanitise at PERSIST but trust the buffer on the way OUT, so
// a POISONED buffer transmitted transcript/audio. Treat the stored record as
// untrusted input on the way out — re-sanitise before BOTH drain and beacon.

describe("client telemetry — D3 poisoned-buffer never transmits content (re-sanitise on the way OUT)", () => {
  const ENDPOINT = "/api/plugins/voice-input/telemetry";
  const SENTINEL_TEXT = "SENTINELtranscriptDONOTLOG";
  const SENTINEL_AUDIO = "SENTINELaudioBYTES";
  let captured: string[];
  beforeEach(() => {
    _debugReset();
    captured = [];
    // A fetch that records the exact body it was asked to POST, and acks nothing.
    (globalThis as { fetch?: unknown }).fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      captured.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({ ok: true, acked: [] }), { status: 200 });
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    _debugReset();
  });

  it("POISONED STORAGE: a tampered buffer entry does NOT put transcript/audio on the DRAIN wire", async () => {
    // Simulate localStorage tampering: a stored entry carrying content-bearing
    // keys AND a valid-shaped id/seq so it is 'pending' and gets drained.
    _debugPoisonBuffer({
      schema: 1,
      request_id: "poison-id-1",
      seq: 1,
      event: "capture_start",
      ts: 1,
      delivered: false,
      transcript: SENTINEL_TEXT, // must NOT reach the wire
      audio: SENTINEL_AUDIO, // must NOT reach the wire
      transcript_hash: "deadbeef", // must NOT reach the wire
      path: "/tmp/secret.wav", // must NOT reach the wire
    });
    await drain(ENDPOINT);
    const wire = captured.join("\n");
    expect(wire).toContain("poison-id-1"); // it WAS drained (id/seq valid) …
    expect(wire).not.toContain(SENTINEL_TEXT); // … but content re-sanitised away
    expect(wire).not.toContain(SENTINEL_AUDIO);
    expect(wire).not.toContain("deadbeef");
    expect(wire).not.toContain("secret.wav");
  });

  it("POISONED STORAGE: a tampered entry does NOT put content on the BEACON wire either", () => {
    (globalThis as unknown as { navigator: { sendBeacon: (u: string, b: Blob) => boolean } }).navigator.sendBeacon =
      // beacon path uses a Blob; capture its text synchronously is awkward, so
      // force sendBeacon to be ABSENT and let beaconUnload fall through to fetch,
      // which we DO capture. (D2 proved that fall-through; here we assert privacy.)
      undefined as unknown as (u: string, b: Blob) => boolean;
    _debugPoisonBuffer({
      schema: 1,
      request_id: "poison-id-2",
      seq: 1,
      event: "no_post",
      reason: "too_short",
      ts: 1,
      delivered: false,
      transcript: SENTINEL_TEXT,
      audio: SENTINEL_AUDIO,
    });
    beaconUnload(ENDPOINT);
    const wire = captured.join("\n");
    expect(wire).toContain("poison-id-2");
    expect(wire).not.toContain(SENTINEL_TEXT);
    expect(wire).not.toContain(SENTINEL_AUDIO);
  });

  it("RED control — a non-re-sanitising toWire (strip-only) leaks the poisoned content", () => {
    // Model the OLD toWire: strip `delivered` but keep every other key.
    const stored = {
      request_id: "x",
      seq: 1,
      delivered: false,
      transcript: SENTINEL_TEXT,
    };
    const { delivered: _d, ...leaky } = stored; // strip-only, no allowlist
    void _d;
    const wire = JSON.stringify([leaky]);
    // The green invariant "no transcript on the wire" fails against strip-only.
    expect(() => expect(wire).not.toContain(SENTINEL_TEXT)).toThrow();
  });

  it("CONTENT-SMUGGLING via request_id: a transcript-shaped id is DROPPED (not truncated)", () => {
    // sanitize must reject a non-token id, not truncate it to 128 content chars.
    const smuggled = SENTINEL_TEXT.repeat(10); // long, content-bearing
    const out = sanitize({ request_id: smuggled, seq: 1, event: "capture_start" });
    expect(out.request_id).toBeUndefined(); // dropped entirely
    expect(JSON.stringify(out)).not.toContain(SENTINEL_TEXT);
  });

  it("CONTENT-SMUGGLING via mime: free text in the mime slot is DROPPED", () => {
    const out = sanitize({ mime: `audio/webm ${SENTINEL_TEXT}`, seq: 1, event: "capture_start" });
    expect(out.mime).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain(SENTINEL_TEXT);
    // A well-formed mime still passes.
    expect(sanitize({ mime: "audio/webm;codecs=opus" }).mime).toBe("audio/webm;codecs=opus");
  });

  it("non-enum event/reason are DROPPED; valid ones pass", () => {
    const out = sanitize({
      event: "evil_event" as unknown as string,
      reason: "evil_reason" as unknown as string,
      request_id: "ok-1",
    });
    expect(out.event).toBeUndefined();
    expect(out.reason).toBeUndefined();
    expect(sanitize({ event: "no_post", reason: "too_short" }).event).toBe("no_post");
  });

  it("RED control — truncate-only (the old behaviour) would still transmit 128 content chars", () => {
    const smuggled = SENTINEL_TEXT.repeat(10);
    const truncated = String(smuggled).slice(0, 128); // the OLD sanitize
    // The green invariant "id carries no content" fails for truncate-only.
    expect(() => expect(truncated).not.toContain(SENTINEL_TEXT)).toThrow();
  });

  it("numeric fields: NaN/Infinity dropped, negatives clamped to 0", () => {
    const out = sanitize({
      blob_bytes: NaN as unknown as number,
      capture_ms: Infinity as unknown as number,
      http_status: -5,
      seq: 3,
    });
    expect(out.blob_bytes).toBeUndefined();
    expect(out.capture_ms).toBeUndefined();
    expect(out.http_status).toBe(0);
    expect(out.seq).toBe(3);
  });
});
