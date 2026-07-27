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

// ONE atomic storage key. seq, overflow, degraded AND the entries live together
// in a single JSON blob written with a single setItem — so a partial write can
// never let the seq counter drift out of sync with the entries it numbers (the
// prior two-key buffer/meta split could diverge if one write succeeded and the
// other failed). v2 supersedes the v1 buffer/meta keys.
const STATE_KEY = "voiceInputTelemetry.state.v2";

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
  | "sidecar_unhealthy_gate" // clicked while the sidecar-health gate refused the attempt
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

// --- Strict validation vocab (D3) ------------------------------------------
// The request id is a random, non-content-derived correlation TOKEN. Constrain
// it to token characters so a poisoned id (e.g. a transcript smuggled into the
// id field) is rejected rather than merely truncated: URL-safe base64 / UUID /
// dash / underscore, 1..64 chars. Anything else is dropped (and the caller
// mints a fresh one at emit, so correlation is never lost).
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
// MIME: type/subtype with an optional `;codecs=...` parameter, bounded length.
// Rejects free text (spaces, punctuation, newlines) that could carry content.
const MIME_RE = /^[A-Za-z0-9!#$&^_.+-]{1,64}\/[A-Za-z0-9!#$&^_.+-]{1,64}(;[A-Za-z0-9=.,"'+ _-]{1,64})?$/;
const EVENT_SET = new Set<TelemetryEvent>([
  "capture_start",
  "capture_end",
  "pre_post",
  "post_result",
  "post_error",
  "no_post",
]);
const REASON_SET = new Set<NoPostReason>([
  "too_short",
  "mic_error",
  "permission_denied",
  "no_navigator",
  "queued_stop_cancel",
  "sidecar_unhealthy_gate",
  "user_cancel",
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

/**
 * The whole telemetry state as ONE atomic unit. Persisted as a single JSON blob
 * under STATE_KEY so `seq` (the monotonic counter) and `entries` (the records it
 * numbers) are written together and can never diverge. `degraded` is STICKY:
 * once memory-fallback happens it stays true for the session (a later successful
 * localStorage write does not silently imply the earlier loss did not occur).
 */
interface State {
  seq: number;
  overflow: number;
  degraded: boolean;
  entries: StoredEntry[];
}

/** Back-compat inspection shape for tests (`_debugReadMeta`). */
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

/**
 * In-memory mirror of the last state we tried to persist. This is the
 * AUTHORITATIVE copy once storage becomes unavailable / write-failing: readState
 * returns it whenever localStorage is absent or `stickyDegraded` is set, so a
 * failed write never reverts us to a stale on-disk blob (the double-quota
 * failure mode).
 */
let memoryState: State = { seq: 0, overflow: 0, degraded: true, entries: [] };

/** Once true, stays true for the session: degraded is STICKY, never reverts. */
let stickyDegraded = false;

/** Serialises drains so two concurrent drains cannot double-POST / double-count. */
let drainChain: Promise<number> = Promise.resolve(0);

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
      overflow: memoryState.overflow,
      // No records, no content — this is a degradation NOTICE, not a delivery.
      records: [],
    });
    // sendBeacon is best-effort. Its boolean is "queued by the UA", not
    // "received" — but a FALSE return means it was NOT even queued (payload too
    // large, disabled, etc.), so we must FALL THROUGH to fetch rather than treat
    // the signal as handled.
    if (nav && typeof nav.sendBeacon === "function") {
      let queued = false;
      try {
        queued = nav.sendBeacon(endpoint, new Blob([envelope], { type: "application/json" }));
      } catch {
        queued = false;
      }
      if (queued) return;
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
        // Numerics: finite only, and clamped non-negative (these are sizes,
        // counts, durations, status, a monotonic seq, a timestamp — none can be
        // meaningfully negative, and NaN/Infinity are dropped).
        const n = Number(v);
        if (Number.isFinite(n)) out[key] = n < 0 ? 0 : n;
        break;
      }
      case "degraded":
        out[key] = Boolean(v);
        break;
      case "net_error": {
        // Class label from a fixed allowlist, never a free message.
        const s = String(v);
        out[key] = ERROR_NAME_ALLOWLIST.has(s) ? s : "unknown";
        break;
      }
      case "request_id": {
        // A random correlation TOKEN. Reject anything that is not token-shaped
        // (drop rather than truncate — a truncated poisoned id would still
        // transmit up to 128 chars of content). A dropped id is re-minted at
        // emit, so correlation is preserved without trusting the input.
        const s = String(v);
        if (REQUEST_ID_RE.test(s)) out[key] = s;
        break;
      }
      case "event": {
        const s = String(v);
        if (EVENT_SET.has(s as TelemetryEvent)) out[key] = s;
        break; // non-enum event → dropped
      }
      case "reason": {
        const s = String(v);
        if (REASON_SET.has(s as NoPostReason)) out[key] = s;
        break; // non-enum reason → dropped
      }
      case "mime": {
        // A container type, never free text. Pattern-validate; drop otherwise.
        const s = String(v);
        if (MIME_RE.test(s)) out[key] = s;
        break;
      }
    }
  }
  return out as unknown as TelemetryRecord;
}

// ---------------------------------------------------------------------------
// Atomic state read/write (single blob) with deterministic eviction.
// ---------------------------------------------------------------------------

/**
 * Read the whole state atomically. Returns the in-memory mirror whenever
 * localStorage is unavailable OR we have gone sticky-degraded (so a failed write
 * never resurrects a stale on-disk blob). `degraded` is OR'd with the sticky
 * flag so it can never read back as false once we have degraded.
 */
function readState(ls: LS | null): State {
  if (!ls || stickyDegraded) {
    return { ...memoryState, degraded: memoryState.degraded || stickyDegraded };
  }
  try {
    const raw = ls.getItem(STATE_KEY);
    if (!raw) return { seq: 0, overflow: 0, degraded: stickyDegraded, entries: [] };
    const s = JSON.parse(raw) as Partial<State>;
    return {
      seq: Number(s.seq) || 0,
      overflow: Number(s.overflow) || 0,
      degraded: Boolean(s.degraded) || stickyDegraded,
      entries: Array.isArray(s.entries) ? (s.entries as StoredEntry[]) : [],
    };
  } catch {
    // Corrupt blob — reset rather than crash. Loss surfaces via overflow on the
    // next write; never throws into the caller.
    return { seq: 0, overflow: 0, degraded: stickyDegraded, entries: [] };
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
 * Write the whole state atomically (single setItem). The in-memory mirror is
 * updated FIRST so it is always the freshest copy; on any storage failure we
 * shed the oldest half once (counting the loss into overflow), and if that still
 * fails we go sticky-degraded and keep serving from memory — never crashing, and
 * never reverting to a stale on-disk blob. Returns the state actually retained.
 */
function writeState(ls: LS | null, state: State): State {
  // Memory mirror is authoritative; keep it current before touching storage.
  const withSticky: State = { ...state, degraded: state.degraded || stickyDegraded };
  memoryState = withSticky;
  if (!ls || stickyDegraded) {
    return withSticky;
  }
  try {
    ls.setItem(STATE_KEY, JSON.stringify(withSticky));
    return withSticky;
  } catch {
    // Quota (or other) failure. Shed oldest half, count the loss, retry once.
    const shed = Math.ceil(withSticky.entries.length / 2);
    const trimmed: State = {
      ...withSticky,
      overflow: withSticky.overflow + shed,
      entries: withSticky.entries.slice(shed),
    };
    memoryState = trimmed;
    try {
      ls.setItem(STATE_KEY, JSON.stringify(trimmed));
      return trimmed;
    } catch {
      // Still failing — go sticky-degraded, keep serving from memory, no crash.
      stickyDegraded = true;
      const degraded: State = { ...trimmed, degraded: true };
      memoryState = degraded;
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
    stickyDegraded = true; // degraded is sticky — memory is now authoritative
    signalDegradedOnce();
  }
  const state = readState(ls);
  const seq = state.seq + 1;

  const record = sanitize({
    ...fields,
    schema: TELEMETRY_SCHEMA,
    request_id: requestId,
    seq,
    event,
    ts: now(),
    degraded: ls && !stickyDegraded ? fields.degraded : true,
  });

  const entry: StoredEntry = { ...record, delivered: false };

  const { kept, evicted } = evict([...state.entries, entry]);
  // seq + entries persisted together in ONE atomic write — they cannot diverge.
  writeState(ls, {
    seq,
    overflow: state.overflow + evicted,
    degraded: state.degraded || !ls || stickyDegraded,
    entries: kept,
  });
  return record;
}

interface AckResponse {
  acked?: Array<{ request_id?: string; seq?: number }>;
}

function undelivered(entries: StoredEntry[]): StoredEntry[] {
  return entries.filter((e) => !e.delivered);
}

/**
 * Project a stored record onto the wire. RE-SANITISES on the way OUT — the
 * stored record is treated as UNTRUSTED input, not just on the way in. This
 * closes the original D3 hole: a poisoned buffer (localStorage tampering, a
 * future write bug, a shape from an older/newer client) could carry transcript
 * or audio fields that persist-time sanitisation never saw. Both transmit paths
 * (drain and beacon) go through here, so both are covered by one guard. Strips
 * `delivered` (local bookkeeping) as a side effect of the allowlist projection.
 */
function toWire(e: StoredEntry): TelemetryRecord {
  return sanitize(e as unknown as Record<string, unknown>);
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
  // Serialise drains: chain each call after the previous so two concurrent
  // drains cannot both POST the same pending records (double-send) or both write
  // back (lost update). Each link is self-contained and never throws.
  const run = drainChain.then(() => drainOnce(endpoint));
  drainChain = run.catch(() => 0);
  return run;
}

async function drainOnce(endpoint: string): Promise<number> {
  const ls = storage();
  const before = readState(ls);
  const pending = undelivered(before.entries);
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
        overflow: before.overflow,
        degraded: before.degraded,
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

  // RE-READ current state after the await and remove ONLY acked keys from the
  // CURRENT entries. A record emitted DURING the fetch is in `after` but not in
  // the pre-await snapshot; filtering the snapshot (the prior bug) would drop it.
  // Key each entry by its SANITISED wire form — the same projection the server
  // saw and acked — so a valid record matches its ack, and a poisoned record
  // (whose invalid id was dropped on the way out) simply never matches and is
  // retained until TTL eviction rather than being force-cleared by a mismatch.
  const after = readState(ls);
  let confirmed = 0;
  const remaining = after.entries.filter((e) => {
    const wire = toWire(e);
    const key = `${wire.request_id}:${wire.seq}`;
    if (typeof wire.request_id === "string" && acked.has(key)) {
      confirmed++;
      return false; // delivered → drop
    }
    return true; // retained (incl. anything emitted during the fetch)
  });
  writeState(ls, { ...after, entries: remaining });
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
  const ls = storage();
  const state = readState(ls);
  const pending = undelivered(state.entries);
  if (pending.length === 0) return false;
  const envelope = JSON.stringify({
    schema: TELEMETRY_SCHEMA,
    overflow: state.overflow,
    degraded: state.degraded,
    records: pending.map(toWire),
  });
  const nav = (globalThis as unknown as { navigator?: Navigator }).navigator;
  // Try sendBeacon first (survives unload). Its boolean is "queued by the UA",
  // NOT "received by the server" — we never mark delivered here. A FALSE return
  // means it was not even queued, so FALL THROUGH to a keepalive fetch rather
  // than treating the flush as handled.
  if (nav && typeof nav.sendBeacon === "function") {
    let queued = false;
    try {
      queued = nav.sendBeacon(endpoint, new Blob([envelope], { type: "application/json" }));
    } catch {
      queued = false;
    }
    if (queued) return true;
  }
  const fetchFn = (globalThis as unknown as { fetch?: typeof fetch }).fetch;
  if (typeof fetchFn === "function") {
    // Best-effort keepalive fetch fallback; result ignored (still not a
    // delivery — an acknowledged drain remains the sole authority for that).
    try {
      void fetchFn(endpoint, {
        method: "POST",
        credentials: "same-origin",
        keepalive: true,
        headers: { "content-type": "application/json" },
        body: envelope,
      }).catch(() => undefined);
    } catch {
      /* best-effort */
    }
  }
  return false;
}

/** Test/inspection helper: current buffer snapshot (read-only copy). */
export function _debugReadBuffer(): TelemetryRecord[] {
  return readState(storage()).entries.map(toWire);
}

/** Test/inspection helper: current meta (overflow/degraded/seq). */
export function _debugReadMeta(): Meta {
  const s = readState(storage());
  return { seq: s.seq, overflow: s.overflow, degraded: s.degraded };
}

/** Test helper: clear all telemetry state (single blob + memory + sticky). */
export function _debugReset(): void {
  memoryState = { seq: 0, overflow: 0, degraded: true, entries: [] };
  stickyDegraded = false;
  drainChain = Promise.resolve(0);
  _degradedSignalSent = false;
  _configuredEndpoint = null;
  const ls = storage();
  if (!ls) return;
  try {
    ls.removeItem(STATE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Test helper: inject a RAW (UN-sanitised) entry straight into the persisted
 * blob, bypassing `emit()`'s sanitisation. Simulates a poisoned buffer —
 * localStorage tampering, an older/newer client shape, or a future write bug —
 * so tests can prove `toWire` re-sanitises on the way OUT (the D3 hole). The
 * raw object may carry content-bearing keys; they must NOT survive to the wire.
 */
export function _debugPoisonBuffer(rawEntry: Record<string, unknown>): void {
  const ls = storage();
  const state = readState(ls);
  const poisoned = { ...state, entries: [...state.entries, rawEntry as unknown as StoredEntry] };
  // Write directly, bypassing sanitisation, to model a hostile on-disk blob.
  if (!ls || stickyDegraded) {
    memoryState = poisoned;
    return;
  }
  try {
    ls.setItem(STATE_KEY, JSON.stringify(poisoned));
  } catch {
    memoryState = poisoned;
  }
}
