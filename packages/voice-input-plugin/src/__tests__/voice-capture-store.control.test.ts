/**
 * Voice control dl-13765 (SERVER mechanism) — the bounded capture store + the
 * server-observed field parsers.
 *
 * These pin the load-bearing server-side properties:
 *  - BOUNDED persistence (req 2): record count, per-record field count, string
 *    length, and retention are all capped — NEVER unbounded growth.
 *  - served engine (req 3): parsed from the EXPLICIT `served_engine` only
 *    (dl-13844); a legacy `engine_used`-only body yields served UNKNOWN.
 *  - fallback (dl-13862): TRI-STATE — the parser returns true/false verbatim or
 *    `null` for UNKNOWN; the caller runs the served≠advertised heuristic ONLY when
 *    served is known, and never collapses unknown to a confident false.
 *  - decoded duration (req 4/dl-13844): parsed from `decoded_duration_ms` (the
 *    TRUE PCM-derived length), NOT `duration_ms` (which is processing latency).
 *  - correlation-key discipline: only a valid UUID is ever stored.
 *
 * Each cap has an able-to-fail control: a version WITHOUT the cap would grow past
 * it; the assertion is exactly that the real store does NOT.
 */
import { describe, expect, it } from "vitest";
import {
  CaptureStore,
  coerceBoundedValue,
  isValidCorrelationId,
  parseServedEngine,
  parseFallbackTaken,
  parseDecodedDurationMs,
  parseProcessingLatencyMs,
  parseAudioEnergy,
  parseEchoedRequestId,
} from "../server/capture-store.js";

const UUID_A = "123e4567-e89b-42d3-a456-426614174000";
const UUID_B = "223e4567-e89b-42d3-a456-426614174111";

function uuid(n: number): string {
  const h = n.toString(16).padStart(8, "0");
  return `${h}-e89b-42d3-a456-426614174000`;
}

describe("dl-13765 SERVER — the store is BOUNDED (never unbounded growth)", () => {
  it("caps record COUNT: a ring of maxRecords evicts oldest first", () => {
    const store = new CaptureStore({ maxRecords: 3, maxFieldsPerRecord: 40, maxStringLen: 80 });
    for (let i = 1; i <= 10; i += 1) store.record(uuid(i), { serverOutcome: "ok" });
    console.log(`CONTROL dl-13765 SERVER(count-cap) ${JSON.stringify({ size: store.size() })}`);
    // RED reference: an unbounded store would hold 10. The bounded store holds ≤3.
    expect(store.size()).toBe(3);
    // The oldest (uuid(1..7)) were evicted; the newest survive.
    expect(store.get(uuid(1))).toBeUndefined();
    expect(store.get(uuid(10))).toBeTruthy();
  });

  it("caps FIELDS per record: excess fields are dropped + counted, not stored", () => {
    const store = new CaptureStore({ maxRecords: 10, maxFieldsPerRecord: 3, maxStringLen: 80 });
    store.record(UUID_A, { a: 1, b: 2, c: 3, d: 4, e: 5 });
    const rec = store.get(UUID_A);
    console.log(`CONTROL dl-13765 SERVER(field-cap) ${JSON.stringify({ fieldCount: Object.keys(rec?.fields ?? {}).length, dropped: rec?.droppedFields })}`);
    expect(Object.keys(rec?.fields ?? {}).length).toBe(3); // capped
    expect(rec?.droppedFields).toBe(2);                    // excess counted
  });

  it("caps STRING length + strips non-printable/whitespace (no free-form content channel)", () => {
    const store = new CaptureStore({ maxRecords: 10, maxFieldsPerRecord: 40, maxStringLen: 8 });
    store.record(UUID_A, { tag: "abcdefghijklmnop\n\t WITHSPACE" });
    const v = store.get(UUID_A)?.fields.tag;
    console.log(`CONTROL dl-13765 SERVER(string-cap) ${JSON.stringify({ v })}`);
    expect(typeof v).toBe("string");
    expect((v as string).length).toBeLessThanOrEqual(8);
  });

  it("REJECTS structured/unbounded values: objects/arrays/functions never stored", () => {
    const store = new CaptureStore({ maxRecords: 10, maxFieldsPerRecord: 40, maxStringLen: 80 });
    store.record(UUID_A, {
      good: 5,
      nested: { huge: "x".repeat(100000) },
      arr: [1, 2, 3],
      fn: () => 1,
      inf: Infinity,
    });
    const fields = store.get(UUID_A)?.fields ?? {};
    console.log(`CONTROL dl-13765 SERVER(reject-structured) ${JSON.stringify({ keys: Object.keys(fields) })}`);
    expect(fields.good).toBe(5);
    expect(fields).not.toHaveProperty("nested"); // object rejected — no payload smuggling
    expect(fields).not.toHaveProperty("arr");    // array rejected
    expect(fields).not.toHaveProperty("fn");     // function rejected
    expect(fields).not.toHaveProperty("inf");    // non-finite number rejected
  });

  it("RETENTION: entries older than retentionMs are pruned on access", () => {
    let now = 1_000_000;
    const store = new CaptureStore(
      { maxRecords: 100, maxFieldsPerRecord: 40, maxStringLen: 80, retentionMs: 1000 },
      () => now,
    );
    store.record(UUID_A, { serverOutcome: "ok" });
    now += 500;
    store.record(UUID_B, { serverOutcome: "ok" });
    now += 600; // A is now 1100ms old (>1000), B is 600ms old
    const size = store.size();
    console.log(`CONTROL dl-13765 SERVER(retention) ${JSON.stringify({ size, hasA: !!store.get(UUID_A), hasB: !!store.get(UUID_B) })}`);
    expect(store.get(UUID_A)).toBeUndefined(); // pruned by age
    expect(store.get(UUID_B)).toBeTruthy();    // still fresh
  });

  it("only a VALID UUID is ever stored (correlation-key discipline)", () => {
    const store = new CaptureStore();
    expect(store.record("not-a-uuid", { a: 1 })).toBe(false);
    expect(store.record("", { a: 1 })).toBe(false);
    expect(store.record(UUID_A, { a: 1 })).toBe(true);
    expect(store.size()).toBe(1);
    expect(isValidCorrelationId(UUID_A)).toBe(true);
    expect(isValidCorrelationId("nope")).toBe(false);
  });

  it("coerceBoundedValue: booleans/finite-numbers/short-strings pass; everything else rejected", () => {
    expect(coerceBoundedValue(true, 80)).toBe(true);
    expect(coerceBoundedValue(42, 80)).toBe(42);
    expect(coerceBoundedValue("ok", 80)).toBe("ok");
    expect(coerceBoundedValue(NaN, 80)).toBeUndefined();
    expect(coerceBoundedValue({}, 80)).toBeUndefined();
    expect(coerceBoundedValue([], 80)).toBeUndefined();
    expect(coerceBoundedValue(null, 80)).toBeUndefined();
  });
});

describe("dl-13844 SERVER — served engine parser is honest about legacy bodies", () => {
  it("legacy-only engine_used yields served UNKNOWN (does NOT infer served from requested)", () => {
    // INVERTED from dl-13792 (which asserted served was parsed FROM engine_used).
    // engine_used is the REQUESTED engine; it does not tell us what actually ran.
    // An old sidecar with only engine_used → served UNKNOWN is the honest answer.
    const legacyBody = JSON.stringify({ transcript: "hi", engine_used: "whisper", duration_ms: 1234 });
    const served = parseServedEngine(legacyBody);
    console.log(`CONTROL dl-13844 SERVER(legacy-served-unknown) ${JSON.stringify({ served })}`);
    expect(served).toBe("unknown");            // NOT "whisper" — engine_used is requested, not served
  });

  it("served engine is 'unknown' for a non-JSON body (no false fallback claim)", () => {
    expect(parseServedEngine("<html>edge error</html>")).toBe("unknown");
    // A served=unknown must NOT be reported as a fallback (guarded at call site).
  });

  it("explicit served_engine wins; legacy-only engine_used still yields unknown", () => {
    // Explicit served_engine is the ONLY authoritative source.
    expect(parseServedEngine(JSON.stringify({ served_engine: "whisper", engine_used: "parakeet" }))).toBe("whisper");
    // INVERTED from dl-13792 ("older sidecar still resolves"): legacy-only
    // engine_used must NOT resolve served — it is requested, so served is unknown.
    expect(parseServedEngine(JSON.stringify({ engine_used: "parakeet" }))).toBe("unknown");
  });

  it("parses the explicit fallback flag; null = UNKNOWN (dl-13862 tri-state input)", () => {
    // true/false are returned verbatim (known). null means the sidecar did not say
    // — dl-13862: that is UNKNOWN, and the caller must NOT collapse it to false; it
    // runs the served≠advertised heuristic ONLY when served is known, else records
    // fallback unknown. explicit false stays distinguishable from null (unknown).
    expect(parseFallbackTaken(JSON.stringify({ fallback_taken: true }))).toBe(true);
    expect(parseFallbackTaken(JSON.stringify({ fallback_taken: false }))).toBe(false);
    expect(parseFallbackTaken(JSON.stringify({ transcript: "x" }))).toBeNull(); // absent = UNKNOWN
    expect(parseFallbackTaken("not json")).toBeNull();
    // explicit false is NOT null — the two must never be merged.
    expect(parseFallbackTaken(JSON.stringify({ fallback_taken: false }))).not.toBeNull();
  });
});

describe("dl-13792 SERVER — TRUE decoded duration vs LEGACY processing latency (the mislabel fix)", () => {
  it("parseDecodedDurationMs reads decoded_duration_ms (PCM), NOT duration_ms (latency)", () => {
    // The corrected contract: decoded_duration_ms is the TRUE audio length.
    const body = JSON.stringify({ decoded_duration_ms: 2000, duration_ms: 17, processing_latency_ms: 17 });
    console.log(`CONTROL dl-13792 mech(true-vs-latency) ${JSON.stringify({ decoded: parseDecodedDurationMs(body), latency: parseProcessingLatencyMs(body) })}`);
    expect(parseDecodedDurationMs(body)).toBe(2000);   // TRUE audio length
    // ABLE-TO-FAIL: the OLD function returned duration_ms (17). The corrected one
    // must NOT — decoded duration and processing latency are DISTINCT.
    expect(parseDecodedDurationMs(body)).not.toBe(17);
  });

  it("does NOT fall back to duration_ms when decoded_duration_ms is absent (old sidecar → null)", () => {
    // An older sidecar with only duration_ms must NOT be mistaken for a decoded
    // duration — that was exactly the mislabel. Absent decoded → null.
    expect(parseDecodedDurationMs(JSON.stringify({ duration_ms: 4200 }))).toBeNull();
    expect(parseDecodedDurationMs(JSON.stringify({ decoded_duration_ms: 900 }))).toBe(900);
    expect(parseDecodedDurationMs("not json")).toBeNull();
    expect(parseDecodedDurationMs(JSON.stringify({ decoded_duration_ms: -5 }))).toBeNull();
  });

  it("parseProcessingLatencyMs reads the legacy field honestly (processing latency)", () => {
    expect(parseProcessingLatencyMs(JSON.stringify({ processing_latency_ms: 17 }))).toBe(17);
    // Older sidecar: duration_ms is the same latency value.
    expect(parseProcessingLatencyMs(JSON.stringify({ duration_ms: 42 }))).toBe(42);
    expect(parseProcessingLatencyMs("not json")).toBeNull();
  });

  it("parseAudioEnergy extracts numbers only — never a sample buffer (req 2)", () => {
    const body = JSON.stringify({
      audio_energy: { peak: 0.61, rms: 0.18, frames_above: 95, frames_total: 100, sample_count: 32000 },
    });
    const e = parseAudioEnergy(body);
    console.log(`CONTROL dl-13792 mech(energy) ${JSON.stringify(e)}`);
    expect(e.energyPeak).toBe(0.61);
    expect(e.energyRms).toBe(0.18);
    expect(e.energyFramesAbove).toBe(95);
    expect(e.energyFramesTotal).toBe(100);
    expect(e.energySampleCount).toBe(32000);
    for (const v of Object.values(e)) expect(v === null || typeof v === "number").toBe(true);
    // Absent → all null (no false energy claim).
    const empty = parseAudioEnergy(JSON.stringify({ transcript: "x" }));
    expect(empty.energyPeak).toBeNull();
    expect(empty.energyFramesTotal).toBeNull();
  });

  it("parseEchoedRequestId returns the echoed id for the join, '' when absent", () => {
    expect(parseEchoedRequestId(JSON.stringify({ request_id: "123e4567-e89b-42d3-a456-426614174000" })))
      .toBe("123e4567-e89b-42d3-a456-426614174000");
    expect(parseEchoedRequestId(JSON.stringify({ transcript: "x" }))).toBe("");
    expect(parseEchoedRequestId("not json")).toBe("");
  });
});
