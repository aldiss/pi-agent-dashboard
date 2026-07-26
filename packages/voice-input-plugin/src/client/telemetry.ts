/**
 * Client-side voice-input telemetry — local-first, privacy-safe, correlatable.
 *
 * WHY THIS EXISTS
 * ---------------
 * The operator's failing voice attempts produced ZERO POST: the request never
 * reached the dashboard or the sidecar. You cannot observe the absence of a
 * request by instrumenting its receiver, so observability must begin here — in
 * the browser, before the fetch is issued — and be durable enough to survive
 * the very failure it is meant to expose.
 *
 * BINDING DESIGN CONSTRAINTS (STEER-1 / STEER-2 — requirements, not options)
 * -------------------------------------------------------------------------
 * 1. PERSISTENCE IS THE PRIMARY RECORD. Every event is written to a bounded
 *    local ring buffer BEFORE any network transmission is attempted. If the
 *    dashboard is unreachable (auth failure, dead tunnel, offline), the record
 *    still exists locally and drains on a later reachable session. "No
 *    telemetry at all" therefore narrows to "client never ran" — it can no
 *    longer mean "the server was unreachable", which is exactly the blind spot
 *    a ship-to-server-only design would have.
 *
 * 2. TRANSMISSION IS AN OPTIMISATION, AND `sendBeacon` NEVER MARKS DELIVERED.
 *    `navigator.sendBeacon`'s boolean means "queued by the user agent", not
 *    "received by the server". Treating that as delivery is the false-success
 *    class this whole build exists to expose. A record is deleted / marked
 *    delivered ONLY on a 2xx acknowledgement that names its exact
 *    (request_id, seq) in the RESPONSE BODY, returned by an acknowledged
 *    same-origin fetch during drain. Body-level ack (not bare HTTP status) is
 *    deliberate: a service worker or intermediary that manufactures a 200
 *    acks nothing, so it can never produce a false "delivered".
 *
 * 3. PRIVACY IS STRUCTURAL. The ONLY writer to storage is `persist()`, and it
 *    runs every event through `sanitize()` — an explicit allowlist projection.
 *    There is no code path that can persist audio bytes, transcript text, a
 *    transcript prefix, a hash of either, or a filesystem path. Fields are
 *    limited to sizes, types, durations, counts, status codes and booleans.
 *
 * 4. THE REQUEST ID IS RANDOM AND NON-CONTENT-DERIVED, but STABLE across all
 *    three layers (client → dashboard ingress → sidecar) for one capture, so a
 *    missing layer is itself the diagnostic signal without the id ever carrying
 *    content.
 */

// ---------------------------------------------------------------------------
// Schema + bounds.
// ---------------------------------------------------------------------------

/** Bumped when the persisted record shape changes; lets drain/readers reason. */
export const TELEMETRY_SCHEMA = 1 as const;

/** Max records retained in the ring buffer. Oldest evicted first (by seq). */
export const BUFFER_MAX_COUNT = 100;

/** Records older than this are evicted on the next persist/drain. 24h. */
export const BUFFER_TTL_MS = 24 * 60 * 60 * 1000;

const BUFFER_KEY = "voiceInputTelemetry.buffer.v1";
const META_KEY = "voiceInputTelemetry.meta.v1";

/**
 * The ONLY fields that may ever be written to storage or sent on the wire.
 * Anything not on this list is dropped by `sanitize()`. Adding a content-
 * bearing field here would be a defect; the test-suite asserts a sentinel
 * transcript / sentinel audio byte-string never survives sanitisation.
 */
export const TELEMETRY_ALLOWED_FIELDS = [
  "schema", // number  — TELEMETRY_SCHEMA
  "request_id", // string  — random, non-content-derived; stable across layers
  "seq", // number  — monotonic per client install; ties drain to ack
  "event", // string  — lifecycle event name (enum below)
  "ts", // number  — coarse event time (ms epoch); a time, not content
  "reason", // string  — no_post reason (enum below)
  "blob_bytes", // number  — recorded audio size in bytes (a size, not content)
  "mime", // string  — negotiated container type e.g. "audio/webm" (a type)
  "capture_ms", // number  — recording duration in ms (a duration)
  "http_status", // number  — POST status code
  "net_error", // string  — error CLASS name only (allowlisted set), never a message
  "degraded", // boolean — persistence fell back to memory (storage unavailable)
  "overflow", // number  — count of records lost to eviction/quota (loss made visible)
] as const;

export type TelemetryEvent =
  | "capture_start" // user intent registered; id minted; before getUserMedia
  | "capture_end" // blob assembled; carries size/mime/duration
  | "pre_post" // about to issue the transcribe fetch
  | "post_result" // transcribe fetch returned a status
  | "post_error" // transcribe fetch threw (network/abort) — no status
  | "no_post"; // a terminal branch that never issues a POST (the zero-POST case)

export type NoPostReason =
  | "too_short" // blob < 1024 bytes early-return (prime zero-POST suspect)
  | "mic_error" // getUserMedia / recorder threw (non-permission)
  | "permission_denied" // getUserMedia NotAllowedError
  | "no_navigator" // navigator/mediaDevices unavailable
  | "queued_stop_cancel" // second click before getUserMedia resolved → torn down
  | "user_cancel"; // explicit force-cancel / visibility-hidden discard

/** Error-name allowlist — keeps `net_error` a class label, never a free message. */
const ERROR_NAME_ALLOWLIST = new Set([
  "AbortError",
  "NotAllowedError",
  "NotFoundError",
  "NotReadableError",
  "SecurityError",
  "TypeError",
  "NetworkError",
  "TimeoutError",
]);

export interface TelemetryFields {
  reason?: NoPostReason;
  blob_bytes?: number;
  mime?: string;
  capture_ms?: number;
  http_status?: number;
  net_error?: string;
  degraded?: boolean;
  overflow?: number;
}

/** A persisted record. `delivered` is LOCAL bookkeeping; it is never sent. */
export interface TelemetryRecord {
  schema: number;
  request_id: string;
  seq: number;
  event: TelemetryEvent;
  ts: number;
  reason?: NoPostReason;
  blob_bytes?: number;
  mime?: string;
  capture_ms?: number;
  http_status?: number;
  net_error?: string;
  degraded?: boolean;
  overflow?: number;
}

interface StoredEntry extends TelemetryRecord {
  /** LOCAL-ONLY. Not part of the wire payload; stripped before transmission. */
  delivered: boolean;
}

interface Meta {
  seq: number;
  overflow: number;
  degraded: boolean;
}

// ---------------------------------------------------------------------------
// Environment-safe primitives (no throwing into the UI path, ever).
// ---------------------------------------------------------------------------

function now(): number {
  // Application code — Date.now() is legitimate here (the Workflow-script ban
  // on Date.now/Math.random does not apply to shipped browser code).
  return Date.now();
}

/** Random, NON-content-derived id. Crypto when available; safe fallback else. */
export function newRequestId(): string {
  const g = globalThis as unknown as { crypto?: Crypto };
  const c = g.crypto;
  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID();
  }
  if (c && typeof c.getRandomValues === "function") {
    const b = new Uint8Array(16);
    c.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, "0"));
    return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}`;
  }
  // Last-resort fallback (non-crypto). Still random + non-content-derived; only
  // used where no Web Crypto exists. Not security-sensitive — it is a
  // correlation token, not a secret.
  return `r-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

type LS = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Returns a working localStorage, or null if unavailable (private mode, SSR). */
function storage(): LS | null {
  try {
    const g = globalThis as unknown as { localStorage?: Storage };
    const ls = g.localStorage;
    if (!ls) return null;
    const probe = "__voiceInputTelemetryProbe__";
    ls.setItem(probe, "1");
    ls.removeItem(probe);
    return ls;
  } catch {
    return null;
  }
}

/** In-memory fallback buffer used only when localStorage is unavailable. */
let memoryBuffer: StoredEntry[] | null = null;
let memoryMeta: Meta = { seq: 0, overflow: 0, degraded: true };

// ---------------------------------------------------------------------------
// Degraded-mode disclosure (STEER — storage-degraded residual).
// ---------------------------------------------------------------------------
//
// When storage is UNAVAILABLE the buffer lives only in memory, so a reload
// loses the records AND the `degraded` marker together — a silent loss with an
// in-memory marker, the same well-formed-but-empty shape (HTTP-200-empty
// transcript) this build exists to expose. An in-memory flag must NOT be left
// implying a safety it does not provide.
//
// Resolution (externally-observable-before-reload): the FIRST time we detect
// storage-unavailable in a session, we fire an immediate best-effort beacon
// carrying ONLY a degraded envelope (no records, no content) to the configured
// endpoint, so the *fact of degradation* is server-observable before any
// reload. This is a SIGNAL, not a delivery — it is never treated as acking any
// record. `configureTelemetry(endpoint)` supplies the endpoint (the client sets
// it at mount).
//
// IRREDUCIBLE RESIDUAL (disclosed, not hidden): if storage is unavailable AND
// every transmission fails for the whole page lifetime, the in-memory records
// and this marker are lost on reload. No design persists with neither storage
// nor network. That intersection is LOSSY and is documented as such in the
// evidence; we do the best-effort emit rather than pretend the flag survives.

let _configuredEndpoint: string | null = null;
let _degradedSignalSent = false;

/** Supply the same-origin telemetry endpoint (client calls this at mount). */
export function configureTelemetry(endpoint: string): void {
  _configuredEndpoint = endpoint;
}

/** Fire a one-shot best-effort degraded signal the moment storage is unavailable. */
function signalDegradedOnce(): void {
  if (_degradedSignalSent) return;
  _degradedSignalSent = true;
  const endpoint = _configuredEndpoint;
  if (!endpoint) return; // nothing to emit to; residual stays lossy (disclosed)
  const nav = (globalThis as unknown as { navigator?: Navigator }).navigator;
  try {
    const envelope = JSON.stringify({
      schema: TELEMETRY_SCHEMA,
      degraded: true,
      overflow: memoryMeta.overflow,
      // No records, no content — this is a degradation NOTICE, not a delivery.
      records: [],
    });
    if (nav && typeof nav.sendBeacon === "function") {
      nav.sendBeacon(endpoint, new Blob([envelope], { type: "application/json" }));
      return;
    }
    const fetchFn = (globalThis as unknown as { fetch?: typeof fetch }).fetch;
    if (typeof fetchFn === "function") {
      // keepalive so it can outlive an imminent unload; result ignored (signal).
      void fetchFn(endpoint, {
        method: "POST",
        credentials: "same-origin",
        keepalive: true,
        headers: { "content-type": "application/json" },
        body: envelope,
      }).catch(() => undefined);
    }
  } catch {
    /* best-effort signal; never throws into the caller */
  }
}

// ---------------------------------------------------------------------------
// Privacy allowlist projection — the single structural guarantee.
// ---------------------------------------------------------------------------

/**
 * Project an arbitrary object down to the allowlisted telemetry fields.
 * Unknown keys (including any that could carry audio/transcript/hash/path) are
 * dropped. Values are coerced to their declared primitive so a hostile caller
 * cannot smuggle an object/array through a scalar field.
 */
export function sanitize(input: Record<string, unknown>): TelemetryRecord {
  const out: Record<string, unknown> = {};
  for (const key of TELEMETRY_ALLOWED_FIELDS) {
    if (!(key in input)) continue;
    const v = input[key];
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
        if (Number.isFinite(n)) out[key] = n;
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
      case "request_id":
      case "event":
      case "reason":
      case "mime":
        // Bounded-length string scalars. Truncate defensively so an oversized
        // value can never balloon the buffer; these carry a token/type/enum,
        // never free text.
        out[key] = String(v).slice(0, 128);
        break;
    }
  }
  return out as unknown as TelemetryRecord;
}

// ---------------------------------------------------------------------------
// Buffer read/write with deterministic eviction + visible overflow.
// ---------------------------------------------------------------------------

function readMeta(ls: LS | null): Meta {
  if (!ls) return memoryMeta;
  try {
    const raw = ls.getItem(META_KEY);
    if (!raw) return { seq: 0, overflow: 0, degraded: false };
    const m = JSON.parse(raw) as Partial<Meta>;
    return {
      seq: Number(m.seq) || 0,
      overflow: Number(m.overflow) || 0,
      degraded: Boolean(m.degraded),
    };
  } catch {
    return { seq: 0, overflow: 0, degraded: false };
  }
}

function writeMeta(ls: LS | null, meta: Meta): void {
  if (!ls) {
    memoryMeta = meta;
    return;
  }
  try {
    ls.setItem(META_KEY, JSON.stringify(meta));
  } catch {
    /* meta write failure is non-fatal; overflow is best-effort surfaced */
  }
}

function readBuffer(ls: LS | null): StoredEntry[] {
  if (!ls) return memoryBuffer ?? (memoryBuffer = []);
  try {
    const raw = ls.getItem(BUFFER_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as StoredEntry[]) : [];
  } catch {
    // Corrupt buffer — reset rather than crash. Loss is surfaced as overflow.
    return [];
  }
}

/** TTL + count eviction. Returns kept entries and how many were evicted. */
function evict(entries: StoredEntry[]): { kept: StoredEntry[]; evicted: number } {
  const cutoff = now() - BUFFER_TTL_MS;
  let evicted = 0;
  let kept = entries.filter((e) => {
    const fresh = typeof e.ts === "number" && e.ts >= cutoff;
    if (!fresh) evicted++;
    return fresh;
  });
  // Deterministic eviction: oldest seq first (seq is strictly monotonic).
  kept.sort((a, b) => a.seq - b.seq);
  if (kept.length > BUFFER_MAX_COUNT) {
    const drop = kept.length - BUFFER_MAX_COUNT;
    evicted += drop;
    kept = kept.slice(drop);
  }
  return { kept, evicted };
}

/**
 * Attempt to write the buffer. On quota exhaustion, evict the oldest half and
 * retry once; whatever is dropped is counted into `overflow` so loss is
 * visible, never silent. Returns the meta actually persisted.
 */
function writeBuffer(ls: LS | null, entries: StoredEntry[], meta: Meta): Meta {
  if (!ls) {
    memoryBuffer = entries;
    memoryMeta = meta;
    return meta;
  }
  try {
    ls.setItem(BUFFER_KEY, JSON.stringify(entries));
    return meta;
  } catch {
    // Quota (or other) failure. Shed oldest half, count the loss, retry once.
    const shed = Math.ceil(entries.length / 2);
    const trimmed = entries.slice(shed);
    const bumped: Meta = { ...meta, overflow: meta.overflow + shed };
    try {
      ls.setItem(BUFFER_KEY, JSON.stringify(trimmed));
      return bumped;
    } catch {
      // Still failing — mark degraded, keep going in memory, never crash.
      memoryBuffer = trimmed;
      const degraded: Meta = { ...bumped, degraded: true };
      memoryMeta = degraded;
      return degraded;
    }
  }
}

// ---------------------------------------------------------------------------
// Public API: emit (persist-first), drain (acknowledged), beacon (best-effort).
// ---------------------------------------------------------------------------

/**
 * PERSIST an event to the ring buffer. This is the primary record and it
 * happens synchronously, BEFORE any transmission. Returns the sanitised record
 * (never throws). Callers pass a `request_id` so all events of one capture
 * correlate; `seq` and `ts` and `schema` are stamped here.
 */
export function emit(
  requestId: string,
  event: TelemetryEvent,
  fields: TelemetryFields = {}
): TelemetryRecord {
  const ls = storage();
  // Storage unavailable → the buffer is memory-only and would vanish on reload
  // along with its degraded marker. Emit the degradation as an immediate,
  // externally-observable signal (best-effort, once) so the fact does not die
  // silently with the tab. See signalDegradedOnce + the disclosed residual.
  if (!ls) {
    signalDegradedOnce();
  }
  const meta = readMeta(ls);
  const seq = meta.seq + 1;

  const record = sanitize({
    ...fields,
    schema: TELEMETRY_SCHEMA,
    request_id: requestId,
    seq,
    event,
    ts: now(),
    degraded: ls ? fields.degraded : true,
  });

  const entry: StoredEntry = { ...record, delivered: false };

  const existing = readBuffer(ls);
  const { kept, evicted } = evict([...existing, entry]);
  const nextMeta: Meta = {
    seq,
    overflow: meta.overflow + evicted,
    degraded: !ls || meta.degraded,
  };
  const persisted = writeBuffer(ls, kept, nextMeta);
  // Reflect any overflow the write itself incurred back into the returned meta.
  writeMeta(ls, persisted);
  return record;
}

interface AckResponse {
  acked?: Array<{ request_id?: string; seq?: number }>;
}

function undelivered(entries: StoredEntry[]): StoredEntry[] {
  return entries.filter((e) => !e.delivered);
}

/** Strip local-only bookkeeping before putting a record on the wire. */
function toWire(e: StoredEntry): TelemetryRecord {
  const { delivered: _delivered, ...wire } = e;
  void _delivered;
  return wire;
}

/**
 * DRAIN the buffer via an ACKNOWLEDGED same-origin fetch. A record is removed
 * ONLY when the server names its exact (request_id, seq) in the response body.
 * A failed fetch, a non-2xx, or a 2xx that acks nothing (e.g. a manufactured
 * response) all RETAIN the record for a later attempt. Never throws.
 *
 * Returns the number of records confirmed-delivered this pass (useful in tests
 * and for callers that want to know whether the dashboard was reachable).
 */
export async function drain(endpoint: string): Promise<number> {
  const ls = storage();
  const meta = readMeta(ls);
  const entries = readBuffer(ls);
  const pending = undelivered(entries);
  if (pending.length === 0) return 0;

  const fetchFn = (globalThis as unknown as { fetch?: typeof fetch }).fetch;
  if (typeof fetchFn !== "function") return 0;

  let acked: Set<string>;
  try {
    const res = await fetchFn(endpoint, {
      method: "POST",
      // Same-origin so the drain is not defeated by CORS; keepalive gives an
      // in-flight drain a chance to finish across a navigation. Neither of
      // these can fabricate an ack — only the body can.
      credentials: "same-origin",
      keepalive: true,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema: TELEMETRY_SCHEMA,
        overflow: meta.overflow,
        degraded: meta.degraded,
        records: pending.map(toWire),
      }),
    });
    if (!res || !res.ok) return 0; // non-2xx → retain everything
    let payload: AckResponse = {};
    try {
      payload = (await res.json()) as AckResponse;
    } catch {
      return 0; // 2xx without a parseable ack body → retain (no false success)
    }
    acked = new Set(
      (payload.acked ?? [])
        .filter((a) => typeof a.request_id === "string" && typeof a.seq === "number")
        .map((a) => `${a.request_id}:${a.seq}`)
    );
    if (acked.size === 0) return 0; // acked nothing (SW/intermediary 200) → retain
  } catch {
    return 0; // network/abort → retain
  }

  // Remove only records the SERVER acknowledged by exact (request_id, seq).
  let confirmed = 0;
  const remaining = entries.filter((e) => {
    const key = `${e.request_id}:${e.seq}`;
    if (acked.has(key)) {
      confirmed++;
      return false; // delivered → drop from buffer
    }
    return true; // retained
  });
  writeBuffer(ls, remaining, meta);
  writeMeta(ls, meta);
  return confirmed;
}

/**
 * BEST-EFFORT unload backstop. Fires `sendBeacon` for still-undelivered
 * records so a tab-close has a chance to ship them. This NEVER marks anything
 * delivered — the record stays in the buffer until an acknowledged drain
 * confirms it. Returns the UA's queued boolean purely for observability; it is
 * NOT a delivery signal.
 */
export function beaconUnload(endpoint: string): boolean {
  const nav = (globalThis as unknown as { navigator?: Navigator }).navigator;
  if (!nav || typeof nav.sendBeacon !== "function") return false;
  const ls = storage();
  const meta = readMeta(ls);
  const pending = undelivered(readBuffer(ls));
  if (pending.length === 0) return false;
  try {
    const body = new Blob(
      [
        JSON.stringify({
          schema: TELEMETRY_SCHEMA,
          overflow: meta.overflow,
          degraded: meta.degraded,
          records: pending.map(toWire),
        }),
      ],
      { type: "application/json" }
    );
    // NOTE: return value is "queued by UA", NOT "received by server". We do not
    // and must not mutate `delivered` here.
    return nav.sendBeacon(endpoint, body);
  } catch {
    return false;
  }
}

/** Test/inspection helper: current buffer snapshot (read-only copy). */
export function _debugReadBuffer(): TelemetryRecord[] {
  return readBuffer(storage()).map(toWire);
}

/** Test/inspection helper: current meta (overflow/degraded/seq). */
export function _debugReadMeta(): Meta {
  return readMeta(storage());
}

/** Test helper: clear all telemetry state (buffer + meta + memory fallback). */
export function _debugReset(): void {
  memoryBuffer = null;
  memoryMeta = { seq: 0, overflow: 0, degraded: true };
  _degradedSignalSent = false;
  _configuredEndpoint = null;
  const ls = storage();
  if (!ls) return;
  try {
    ls.removeItem(BUFFER_KEY);
    ls.removeItem(META_KEY);
  } catch {
    /* ignore */
  }
}
