/**
 * Bounded server-side voice capture-record store (dl-13765 req 2).
 *
 * WHY. The client-side capture tracking (dl-13723) emits a rich `voice.capture`
 * line to a device console sink, which does NOT survive a page reload — and the
 * retention incident this instruments (dl-13769: force-quitting the dashboard PWA
 * recovered the native Camera, so the retaining consumer lives in the
 * dashboard/WebKit process — established process attribution, UNPROVEN internal
 * owner) is exactly the kind of failure that outlives the page. So a bounded,
 * server-side record must survive it.
 *
 * WHAT IT IS. A per-`correlationId` store built ONLY from what the SERVER OBSERVES
 * (the transcribe handler already sees served engine, sidecar-decoded duration,
 * 502 class, upstream status) plus the coarse client `recording-stopped` linkage
 * the existing telemetry route already accepts. It does NOT widen the dl-12467
 * ENUM gate: the server never trusts a rich client field; it records its own
 * observations, keyed by the UUID the gate already validates.
 *
 * BOUNDED — never unbounded growth (req 2, HARD):
 *  - at most `maxRecords` entries (ring: oldest evicted first),
 *  - at most `maxFieldsPerRecord` fields per record (excess dropped, counted),
 *  - every value coerced to a bounded primitive (string clamped to `maxStringLen`,
 *    finite number, boolean) — objects/arrays are rejected so no nested payload
 *    can smuggle unbounded content,
 *  - optional `retentionMs`: entries older than it are pruned on access.
 *
 * PRIVACY — numbers, enums, booleans, timestamps only. No transcript, no audio,
 * no waveform, no exact audio byte count (size CLASSES only). A string field is a
 * short enum/token/UUID, clamped; it is never a free-form content channel.
 */

export interface CaptureStoreLimits {
  maxRecords: number;
  maxFieldsPerRecord: number;
  maxStringLen: number;
  /** Prune entries older than this many ms on access. 0/undefined = no time bound. */
  retentionMs?: number;
}

export const DEFAULT_CAPTURE_STORE_LIMITS: CaptureStoreLimits = {
  maxRecords: 200,
  maxFieldsPerRecord: 40,
  maxStringLen: 80,
  retentionMs: 60 * 60 * 1000, // 1 hour
};

/** A stored record: only bounded primitives, plus the server-stamped receive time. */
export interface CaptureRecord {
  correlationId: string;
  receivedAt: number;
  fields: Record<string, string | number | boolean>;
  /** How many incoming fields were dropped by the per-record field cap. */
  droppedFields: number;
}

/** UUID v4 — the ONLY id shape accepted as a correlation key (matches the gate). */
const CORRELATION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidCorrelationId(id: unknown): id is string {
  return typeof id === "string" && CORRELATION_ID_RE.test(id);
}

/**
 * Coerce ONE incoming value to a bounded primitive, or return `undefined` to
 * reject it. Strings clamp to `maxStringLen` and are stripped of non-printable /
 * whitespace runs (same discipline as the server's `sanitizeIdentity`), so a
 * value can never be a large or structured content channel. Non-finite numbers,
 * objects, arrays, functions, symbols are rejected.
 */
export function coerceBoundedValue(
  value: unknown,
  maxStringLen: number,
): string | number | boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const cleaned = value.replace(/[^\x20-\x7E]/g, "").replace(/\s+/g, " ").trim().slice(0, maxStringLen);
    return cleaned;
  }
  return undefined; // reject objects/arrays/null/undefined/functions/symbols
}

/**
 * A bounded, in-memory, per-correlationId capture store. Single instance lives on
 * PluginState. All growth is capped; nothing here can grow without bound.
 */
export class CaptureStore {
  private readonly limits: CaptureStoreLimits;
  private readonly order: string[] = []; // insertion order of correlationIds (ring)
  private readonly byId = new Map<string, CaptureRecord>();
  private readonly now: () => number;

  constructor(limits: CaptureStoreLimits = DEFAULT_CAPTURE_STORE_LIMITS, now: () => number = Date.now) {
    this.limits = limits;
    this.now = now;
  }

  /**
   * Merge `fields` into the record for `correlationId` (creating it if absent).
   * Returns false (a no-op) if the id is not a valid UUID — the store never holds
   * an unvalidated key. Enforces every bound on the way in.
   */
  record(correlationId: string, fields: Record<string, unknown>): boolean {
    if (!isValidCorrelationId(correlationId)) return false;
    this.pruneExpired();
    let entry = this.byId.get(correlationId);
    if (!entry) {
      entry = { correlationId, receivedAt: this.now(), fields: {}, droppedFields: 0 };
      this.byId.set(correlationId, entry);
      this.order.push(correlationId);
      this.evictOverflow();
    }
    for (const [k, v] of Object.entries(fields)) {
      if (Object.prototype.hasOwnProperty.call(entry.fields, k)) {
        const coerced = coerceBoundedValue(v, this.limits.maxStringLen);
        if (coerced !== undefined) entry.fields[k] = coerced; // update existing key freely
        continue;
      }
      if (Object.keys(entry.fields).length >= this.limits.maxFieldsPerRecord) {
        entry.droppedFields += 1; // per-record field cap — excess counted, not stored
        continue;
      }
      const coerced = coerceBoundedValue(v, this.limits.maxStringLen);
      if (coerced === undefined) continue; // reject unbounded/structured value
      entry.fields[k] = coerced;
    }
    return true;
  }

  get(correlationId: string): CaptureRecord | undefined {
    this.pruneExpired();
    return this.byId.get(correlationId);
  }

  /** All records, newest first, already pruned. A bounded snapshot (≤ maxRecords). */
  list(): CaptureRecord[] {
    this.pruneExpired();
    return this.order
      .map((id) => this.byId.get(id))
      .filter((r): r is CaptureRecord => r !== undefined)
      .reverse();
  }

  size(): number {
    this.pruneExpired();
    return this.byId.size;
  }

  private evictOverflow(): void {
    while (this.order.length > this.limits.maxRecords) {
      const oldest = this.order.shift();
      if (oldest !== undefined) this.byId.delete(oldest);
    }
  }

  private pruneExpired(): void {
    const ttl = this.limits.retentionMs;
    if (!ttl || ttl <= 0) return;
    const cutoff = this.now() - ttl;
    // order is insertion-time-ascending; stop at the first still-fresh entry.
    while (this.order.length > 0) {
      const id = this.order[0];
      const rec = this.byId.get(id);
      if (!rec) { this.order.shift(); continue; }
      if (rec.receivedAt >= cutoff) break;
      this.order.shift();
      this.byId.delete(id);
    }
  }
}

/**
 * Classify the server-side 502 CLASS for a transcribe outcome (dl-13765 req 5,
 * server half). The server can only mint APPLICATION-level 502s; an edge/proxy
 * (Cloudflare) 502 is injected between the browser and the dashboard and never
 * reaches this server, so it is classified CLIENT-side. This names the three
 * application 502 causes distinctly so they stop looking identical downstream.
 */
export type Server502Class =
  | "app-2xx-empty"        // upstream 2xx but empty transcript → typed EmptyUpstreamTranscript
  | "app-proxy-exception"  // fetch to sidecar threw (network/abort) → Sidecar proxy failed
  | "app-sidecar-unhealthy" // health gate tripped before proxying
  | "none";                // not a 502

/**
 * Parse the sidecar's SERVED engine from its response body WITHOUT retaining any
 * content. The advertised engine is what the dashboard REQUESTED; the served
 * engine is what the sidecar actually used (it may fall back parakeet→whisper).
 *
 * dl-13844 (backward-compat correction): the ONLY authoritative source of the
 * served engine is the explicit `served_engine` field. `engine_used` is a LEGACY
 * field whose meaning is the REQUESTED engine — it does NOT tell us what actually
 * ran, so it is NOT consulted here. An older sidecar that emits only `engine_used`
 * yields served = "unknown", which is the correct honest answer: inferring served
 * from requested would re-introduce the advertised-vs-served conflation this record
 * exists to eliminate, and a plausible wrong value silently corrupts the diagnosis.
 * An unknown labelled unknown is strictly better than a confident wrong value.
 */
export function parseServedEngine(respBody: string): string {
  try {
    const parsed = JSON.parse(respBody) as { served_engine?: unknown };
    const served = parsed.served_engine;
    if (typeof served === "string" && /^[a-z0-9_-]{1,40}$/i.test(served)) return served;
  } catch {
    /* non-JSON body — served engine unknown */
  }
  // No explicit served_engine (or unparseable): served is genuinely UNKNOWN. Do
  // NOT fall back to engine_used — that is the requested engine, not the served one.
  return "unknown";
}

/**
 * Parse the sidecar's EXPLICIT fallback flag (dl-13792 req 3). The sidecar knows,
 * from inside its own transcribe path, whether the parakeet→whisper fallback was
 * taken; that is authoritative. Returns `true`/`false` verbatim when present.
 *
 * Returns `null` when the field is absent (older sidecar). dl-13862: `null` means
 * UNKNOWN, not `false` — it is the caller's cue to make fallback tri-state. The
 * caller may run the served≠advertised heuristic ONLY when the served engine is
 * KNOWN; when served is `"unknown"` (a legacy engine_used-only body) the fallback
 * stays UNKNOWN and must NEVER be recorded as `false`.
 */
export function parseFallbackTaken(respBody: string): boolean | null {
  try {
    const parsed = JSON.parse(respBody) as { fallback_taken?: unknown };
    if (typeof parsed.fallback_taken === "boolean") return parsed.fallback_taken;
  } catch {
    /* non-JSON body — unknown */
  }
  return null;
}

/**
 * Parse the TRUE decoded duration (dl-13792 req 1). This is `decoded_duration_ms`,
 * derived by the sidecar from the PCM sample count / sample rate — the ACTUAL
 * audio length.
 *
 * CORRECTION (dl-13792): the previous version of this function read `duration_ms`
 * and the report called it "the ACTUAL decoded duration". That was WRONG:
 * `duration_ms` is the sidecar's wall-clock PROCESSING LATENCY
 * (`monotonic() - start`), unrelated to audio length. The true decoded duration is
 * `decoded_duration_ms`; the legacy latency is read separately below. Returns null
 * when absent (older sidecar) rather than silently using the latency field.
 */
export function parseDecodedDurationMs(respBody: string): number | null {
  try {
    const parsed = JSON.parse(respBody) as { decoded_duration_ms?: unknown };
    const d = parsed.decoded_duration_ms;
    if (typeof d === "number" && Number.isFinite(d) && d >= 0) return d;
  } catch {
    /* non-JSON body — decoded duration unknown */
  }
  return null;
}

/**
 * Parse the LEGACY `duration_ms` — HONESTLY as processing latency, NOT audio
 * length (dl-13792 req 5). Preserved for continuity; never conflated with decoded
 * duration. Returns null when absent.
 */
export function parseProcessingLatencyMs(respBody: string): number | null {
  try {
    const parsed = JSON.parse(respBody) as {
      processing_latency_ms?: unknown;
      duration_ms?: unknown;
    };
    const d = parsed.processing_latency_ms ?? parsed.duration_ms;
    if (typeof d === "number" && Number.isFinite(d) && d >= 0) return d;
  } catch {
    /* non-JSON body — latency unknown */
  }
  return null;
}

/**
 * A privacy-safe subset of the sidecar's `audio_energy` aggregate (dl-13792 req 2)
 * — numbers only, no samples. Coerced defensively; missing/invalid fields become
 * null so a malformed body can never inject anything but numbers.
 */
export interface AudioEnergyFields {
  energyPeak: number | null;
  energyRms: number | null;
  energyFramesAbove: number | null;
  energyFramesTotal: number | null;
  energySampleCount: number | null;
}

const numOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * Parse the sidecar's bounded energy aggregate into flat numeric fields for the
 * capture store. Reads ONLY numbers from `audio_energy`; never a sample buffer.
 * Amplitude is NOT speech — these are physical energy aggregates over the PCM.
 */
export function parseAudioEnergy(respBody: string): AudioEnergyFields {
  const empty: AudioEnergyFields = {
    energyPeak: null, energyRms: null, energyFramesAbove: null,
    energyFramesTotal: null, energySampleCount: null,
  };
  try {
    const parsed = JSON.parse(respBody) as { audio_energy?: unknown };
    const e = parsed.audio_energy;
    if (e && typeof e === "object") {
      const o = e as Record<string, unknown>;
      return {
        energyPeak: numOrNull(o.peak),
        energyRms: numOrNull(o.rms),
        energyFramesAbove: numOrNull(o.frames_above),
        energyFramesTotal: numOrNull(o.frames_total),
        energySampleCount: numOrNull(o.sample_count),
      };
    }
  } catch {
    /* non-JSON body — no energy */
  }
  return empty;
}

/**
 * Parse the echoed correlation id (dl-13792 req 4). The sidecar echoes the
 * `request_id` it received so its record joins the dashboard captureAttemptId
 * chain. Returns "" when absent. Validated as a bounded token by the caller.
 */
export function parseEchoedRequestId(respBody: string): string {
  try {
    const parsed = JSON.parse(respBody) as { request_id?: unknown };
    if (typeof parsed.request_id === "string") return parsed.request_id.slice(0, 80);
  } catch {
    /* non-JSON body */
  }
  return "";
}
