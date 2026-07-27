/**
 * Dashboard-side telemetry sink for the voice-input plugin.
 *
 * This is Layer 2 of the three-layer observability path (client → dashboard
 * ingress → sidecar). It receives the client's local-first telemetry records
 * and turns them into durable, correlatable log lines — and, critically, it
 * ISSUES THE ACKNOWLEDGEMENT that lets the client mark a record delivered.
 *
 * Two binding properties (STEER-2):
 *
 * 1. IDEMPOTENT + DEDUPED. The client retains a record until it sees a 2xx that
 *    names its exact (request_id, seq). If the client's first drain reached us
 *    but its ack was lost, the client retries. On a retry we MUST ack again (so
 *    the client can finally clear it) but MUST NOT log again (no double-count).
 *    Hence: ack every well-formed record; log only first-seen ones.
 *
 * 2. PRIVACY IS STRUCTURAL, SERVER-SIDE TOO. We never trust the client to have
 *    stripped content. Every record is run through `sanitizeRecord()` — an
 *    explicit allowlist projection — before it is logged. A hostile or broken
 *    client that sends a transcript/audio field cannot get it into our logs.
 */

/** The ONLY fields this sink will log. Mirrors the client allowlist exactly. */
export const SINK_ALLOWED_FIELDS = [
  "schema",
  "request_id",
  "seq",
  "event",
  "ts",
  "reason",
  "blob_bytes",
  "mime",
  "capture_ms",
  "http_status",
  "net_error",
  "degraded",
  "overflow",
] as const;

/** Error-name allowlist — keeps net_error a class label, never a free message. */
const ERROR_NAME_ALLOWLIST = new Set([
  "AbortError",
  "NotAllowedError",
  "NotFoundError",
  "NotReadableError",
  "SecurityError",
  "TypeError",
  "NetworkError",
  "TimeoutError",
  "unknown",
]);

// --- Strict validation vocab (D3) — mirrors the client sanitiser -------------
// The sink treats every incoming record as HOSTILE input. A poisoned client, a
// tampered buffer, or a smuggling attempt must not get a content-bearing value
// (transcript/audio/hash/path) into a log line via a scalar slot. Token / enum
// / MIME shapes are validated (not merely truncated): a non-conforming value is
// DROPPED so it can never be logged.
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MIME_RE = /^[A-Za-z0-9!#$&^_.+-]{1,64}\/[A-Za-z0-9!#$&^_.+-]{1,64}(;[A-Za-z0-9=.,"'+ _-]{1,64})?$/;
const EVENT_SET = new Set([
  "capture_start",
  "capture_end",
  "pre_post",
  "post_result",
  "post_error",
  "no_post",
]);
const REASON_SET = new Set([
  "too_short",
  "mic_error",
  "permission_denied",
  "no_navigator",
  "queued_stop_cancel",
  "sidecar_unhealthy_gate",
  "user_cancel",
]);

export interface SanitizedRecord {
  schema?: number;
  request_id?: string;
  seq?: number;
  event?: string;
  ts?: number;
  reason?: string;
  blob_bytes?: number;
  mime?: string;
  capture_ms?: number;
  http_status?: number;
  net_error?: string;
  degraded?: boolean;
  overflow?: number;
}

/**
 * Project an arbitrary object down to the allowlisted fields, coercing each to
 * its declared primitive so an object/array cannot be smuggled through a scalar
 * slot. Anything not on the allowlist (audio, transcript, prefix, hash, path)
 * is dropped. This is the sole structural privacy guarantee on the sink side.
 */
export function sanitizeRecord(input: unknown): SanitizedRecord {
  const src = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const out: SanitizedRecord = {};
  for (const key of SINK_ALLOWED_FIELDS) {
    if (!(key in src)) continue;
    const v = src[key];
    if (v === undefined || v === null) continue;
    switch (key) {
      case "schema":
      case "seq":
      case "ts":
      case "blob_bytes":
      case "capture_ms":
      case "http_status":
      case "overflow": {
        const n = Number(v);
        if (Number.isFinite(n)) out[key] = n < 0 ? 0 : n; // finite, non-negative
        break;
      }
      case "degraded":
        out[key] = Boolean(v);
        break;
      case "net_error": {
        const s = String(v);
        out[key] = ERROR_NAME_ALLOWLIST.has(s) ? s : "unknown";
        break;
      }
      case "request_id": {
        const s = String(v);
        if (REQUEST_ID_RE.test(s)) out[key] = s; // token-shaped only, else dropped
        break;
      }
      case "event": {
        const s = String(v);
        if (EVENT_SET.has(s)) out[key] = s; // enum only, else dropped
        break;
      }
      case "reason": {
        const s = String(v);
        if (REASON_SET.has(s)) out[key] = s; // enum only, else dropped
        break;
      }
      case "mime": {
        const s = String(v);
        if (MIME_RE.test(s)) out[key] = s; // container type only, else dropped
        break;
      }
    }
  }
  return out;
}

export interface IngestResult {
  /** Records to acknowledge back to the client (first-seen AND duplicates). */
  acked: Array<{ request_id: string; seq: number }>;
  /** Count of records newly logged this call (excludes duplicates). */
  logged: number;
  /** Count of records rejected as malformed (missing id/seq). */
  rejected: number;
}

export type SinkLogger = (record: SanitizedRecord & { layer: "client" }) => void;

/**
 * Idempotent telemetry sink. Dedup is by (request_id, seq) held in a bounded
 * in-memory set — process-local, which is the correct scope for "a retried
 * record must not double-count": retries happen within seconds/minutes of the
 * original, well inside a process lifetime. The bound (FIFO eviction) prevents
 * unbounded growth; an evicted key can at worst cause one extra (idempotent)
 * log line on a very late retry — never a lost ack, never a crash.
 */
export class TelemetrySink {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];
  private readonly maxKeys: number;
  private readonly log: SinkLogger;

  constructor(log: SinkLogger, maxKeys = 10_000) {
    this.log = log;
    this.maxKeys = maxKeys;
  }

  private remember(key: string): boolean {
    if (this.seen.has(key)) return false; // duplicate
    this.seen.add(key);
    this.order.push(key);
    if (this.order.length > this.maxKeys) {
      const evicted = this.order.shift();
      if (evicted !== undefined) this.seen.delete(evicted);
    }
    return true; // first-seen
  }

  /**
   * Ingest a batch of client records. Returns which to ack (all well-formed
   * that were durably handled, so the client can clear even retried ones) and
   * how many were newly logged.
   *
   * ACK-ONLY-AFTER-SIDE-EFFECT (binding, STEER-2 / Lane): a first-seen record
   * is marked seen AND acked ONLY AFTER `this.log()` returns without throwing.
   * If the side effect throws, the record is neither remembered nor acked — so
   * the client RETAINS it and retries, rather than deleting its only copy on
   * the strength of an ack for a write that never happened. That false-ack is
   * exactly the defect class this build exists to expose; we must not reproduce
   * it in the detector.
   *
   * Guarantee boundary: "the log call returned" — a synchronous success. If the
   * logger buffers and a later async transport flush fails, that is OUTSIDE
   * this boundary; the limitation is disclosed in the evidence, not hidden.
   */
  ingest(records: unknown[]): IngestResult {
    const acked: Array<{ request_id: string; seq: number }> = [];
    let logged = 0;
    let rejected = 0;

    for (const raw of records) {
      const rec = sanitizeRecord(raw);
      // A record is only addressable if it carries the correlation coordinates.
      if (typeof rec.request_id !== "string" || typeof rec.seq !== "number") {
        rejected++;
        continue; // NOT acked — a malformed record must never be falsely acked.
      }
      const key = `${rec.request_id}:${rec.seq}`;

      if (this.seen.has(key)) {
        // Duplicate (lost-ack retry): re-ack WITHOUT re-logging. Idempotent.
        acked.push({ request_id: rec.request_id, seq: rec.seq });
        continue;
      }

      // First-seen: attempt the side effect FIRST. Only on success do we mark
      // seen + ack. The record is already sanitised — no content can reach the
      // log line.
      try {
        this.log({ ...rec, layer: "client" });
      } catch {
        // Side effect failed → do NOT remember, do NOT ack. Client retains it
        // and will retry on a later drain. No false success.
        continue;
      }
      this.remember(key);
      logged++;
      acked.push({ request_id: rec.request_id, seq: rec.seq });
    }

    return { acked, logged, rejected };
  }
}
