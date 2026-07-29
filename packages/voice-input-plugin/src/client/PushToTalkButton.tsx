/**
 * PushToTalkButton — click-to-toggle voice-input microphone button for
 * pi-dashboard's CommandInput.
 *
 * UX (per operator-direct ratification 2026-05-14 ~12:55 CEST: "so, on the
 * voice input - can we switch to click?" — operator-verbatim per Pattern 87):
 *
 *   idle  --click-->  recording  --click-->  uploading  -->  idle
 *                                --auto-stop--> uploading --> interrupted
 *
 * On second click while `recording`, the in-flight MediaRecorder is stopped,
 * the captured Blob is POSTed to `endpoint`, the transcript is appended to
 * the consumer's input field via `onTranscript`, and the button returns to
 * idle. Successful visibility/safety auto-stops instead persist as
 * `interrupted` until acknowledged. State `error` auto-recovers to idle after
 * 6s OR on next click.
 *
 * Public API contract (preserved across UX evolutions; consumers in
 * packages/client/src/components/CommandInput.tsx VOICE-INPUT-LOCAL-PATCH
 * block + packages/client/src/components/MobileComposer/MobileComposer.tsx
 * rely on this signature being stable):
 *
 *   props = {
 *     onTranscript: (transcript: string) => void;
 *     endpoint?:       string;        // POST audio Blob here
 *     healthEndpoint?: string;        // GET sidecar health
 *     disabled?:       boolean;
 *     className?:      string;
 *     idleTitle?:      string;
 *     onStreamChange?: (stream: MediaStream | null) => void;
 *   }
 *
 * Risk-mitigation discipline (load-bearing; do NOT remove without surfacing):
 *
 *   - Risk #12 10min safety-net (`MAX_RECORDING_MS = 600_000`): auto-stop
 *     after the configured timeout even if user forgets to click again.
 *     Under click-to-toggle this is more load-bearing than under
 *     press-and-hold, because there is no `pointerup` natural-cancel path.
 *
 *   - Fast-double-click race-fix (`inFlightStartRef` + `pendingStopRef`):
 *     if user clicks twice within ~200ms (before `getUserMedia` resolves),
 *     queue the stop-intent and flush after start completes — prevents a
 *     stuck-recording state. Same race-shape as press-and-hold-then-quick-
 *     release; queued-stop flush mechanism preserved verbatim.
 *
 *   - Sidecar-health gate: poll `healthEndpoint` every 5s; disable button
 *     and surface "Voice service starting…" title while sidecar reports
 *     unhealthy. Operator-empirical 2026-05-13: cold-start sidecar takes
 *     ~3-6s for ONNX model load; clicking during that window led to
 *     spurious 503 errors before this gate landed.
 *
 *   - Visibility-change auto-stop: if tab goes hidden while recording,
 *     stop+upload immediately. Operator-empirical: forgotten recordings
 *     drained battery on iOS PWA when tab was backgrounded.
 *
 * Marker discipline (per voice-input/v1 amended capsule-bundle Q3): this
 * file is part of the workspace plugin package; integration-layer at
 * packages/client/src/components/CommandInput.tsx carries the
 * `VOICE-INPUT-LOCAL-PATCH-START` / `VOICE-INPUT-LOCAL-PATCH-END` markers
 * that are grep-discoverable for v1.x migration to a chat-input-augment
 * slot upstream PR.
 */
import React, {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
} from "react";

/* eslint-disable react-hooks/exhaustive-deps */

const DEFAULT_ENDPOINT = "/api/plugins/voice-input/transcribe";
const DEFAULT_HEALTH = "/api/plugins/voice-input/health";

/**
 * 10min safety-net auto-stop (Risk #12 per voice-input-substrate-r1 ship). This
 * matches the canonical PushToTalkButton.test.tsx expectation; under
 * click-to-toggle it is more load-bearing than under press-and-hold because
 * there is no `pointerup` natural-cancel path.
 *
 * History: substrate-r1 shipped 60_000 (60s). 2026-05-17 FastUnion raised to
 * 300_000 (5min) for longer dictation, but the test was not updated, so the
 * 2026-05-22 recovery commit (8308224) reverted to 60_000 to keep the test
 * PASS-able. 2026-06-03 operator-direct raised to 600_000 (10min) with the
 * test updated in the same change per Schema 5 § 3.9 SAME-COMMIT discipline.
 */
const MAX_RECORDING_MS = 600_000;

const SIDECAR_HEALTH_POLL_INTERVAL_MS = 5_000;
const ERROR_AUTO_CLEAR_MS = 6_000;

/** Stable wire tokens shared with the proxy telemetry contract. */
export enum VoiceStopReason {
  ManualStop = "manual-stop",
  VisibilityAutoStop = "visibility-auto-stop",
  SafetyNetAutoStop = "safety-net-auto-stop",
}

export type InterruptionDetail = "partial-transcript" | "too-brief-to-transcribe";

/**
 * Human wording is derived from both the automatic stop source and whether
 * there was enough audio to transcribe. Keeping this as rendered copy (rather
 * than a title-only tooltip) makes the cause available on touch devices.
 */
export function interruptedReasonText(
  stopReason: VoiceStopReason,
  detail: InterruptionDetail,
): string {
  if (detail === "too-brief-to-transcribe") {
    return stopReason === VoiceStopReason.VisibilityAutoStop
      ? "The app went into background before enough audio was captured; the recording was too brief to transcribe."
      : "The safety stop captured too little audio; the recording was too brief to transcribe.";
  }
  return stopReason === VoiceStopReason.VisibilityAutoStop
    ? "The app went into background; the transcript may be incomplete."
    : "The 10-minute safety limit was reached; the transcript may be incomplete.";
}

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Generate one opaque RFC4122-v4 correlation id per recording. */
export function createVoiceRequestId(): string {
  const cryptoApi = typeof globalThis.crypto === "undefined" ? undefined : globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    const generated = cryptoApi.randomUUID().toLowerCase();
    if (UUID_V4_RE.test(generated)) return generated;
  }

  const bytes = new Uint8Array(16);
  if (cryptoApi && typeof cryptoApi.getRandomValues === "function") {
    cryptoApi.getRandomValues(bytes);
  } else {
    throw new Error("Secure random UUID generation unavailable");
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
}

/**
 * Distinct operator-visible messages — criterion 2 + the dl-12467 code finding.
 *
 * The pre-fix build threw the SAME "Recording too short (click and wait longer)"
 * for TWO structurally opposite failures: (a) a pre-POST blob < 1KiB (nothing was
 * ever sent) and (b) an HTTP-200 carrying an empty transcript (the backend
 * returned nothing). That collision misattributed a backend-empty return to the
 * operator's recording duration and auto-cleared after 6s leaving no trace.
 *
 * These three are mutually distinct BY CONSTRUCTION (a test asserts the set size
 * is 3). Duration language appears ONLY in SHORT_BLOB, where duration genuinely
 * IS the cause — the other two never blame the operator.
 */
export const VOICE_MESSAGES = {
  /** Pre-POST: recorded blob < 1KiB → nothing was sent. Duration IS the cause. */
  SHORT_BLOB: "Recording too short (click and wait longer)",
  /** HTTP 422 EmptyTranscriptError: backend ran clean but heard no speech. */
  NO_SPEECH: "No speech detected — speak a little louder, closer to the mic",
  /** 200-empty (defense) or 502 EmptyUpstreamTranscript: service returned no
   *  text. A service fault, NOT the operator's recording. */
  EMPTY_RESPONSE: "Voice service returned an empty result — please try again",
} as const;

/**
 * Which client bundle is EXECUTING (T5/T10) — identity-only, no payload.
 *
 * Derived from the EXECUTING module's own URL (`import.meta.url`). In a built
 * bundle this is the hashed chunk that actually ran (…/assets/index-<hash>.js
 * or …/<chunk>-<hash>.js), so it answers dl-12467's open observable: "which
 * code ran on the device". It reads NOTHING from the DOM, so a decoy
 * `<script src="…index-DECOY.js">` tag that never executes CANNOT spoof it —
 * decoy tags are rejected by construction (nothing consults them). Returns
 * "unknown" for an un-hashed URL (dev source module), which is an honest
 * recorded value, not a spoofable one. Never throws.
 */
export function readClientBuildId(moduleUrl: string = import.meta.url): string {
  try {
    const file = String(moduleUrl).split(/[?#]/)[0].split("/").pop() || "";
    // Match the FINAL "-<hash>.js|mjs" segment; hash excludes "-" so a name
    // like "index-legacy-<hash>.js" still yields just the hash.
    const m = file.match(/-([A-Za-z0-9_]{6,})\.(?:m?js)$/);
    if (m) return m[1];
  } catch {
    /* defensive */
  }
  return "unknown";
}

/**
 * Service-worker identity for this page (T6) — BOTH the registration lifecycle
 * (installing / waiting / active) AND the controller state, never either alone.
 * The SW caches `/assets` cache-first and parks updates in `waiting` (see
 * public/sw.js), so a stale precached bundle is possible in principle; reporting
 * ONLY `controller.state` (the pre-fix gap) hides an installing/waiting update.
 * Async because registration lifecycle is only reachable via `getRegistration()`.
 * Shape: "reg:<installing|waiting|active|registered|none|unknown>[:<state>];ctrl:<state|none>".
 *
 * CRITICAL (dl-12564 #3): `reg:none` means "asked, and no registration exists"
 * — it is only emitted after a SUCCESSFUL undefined result. If getRegistration()
 * REJECTS we could-not-ask, which is `reg:unknown`, NOT `reg:none`. Collapsing
 * a failed read into a confirmed-absence would report a POSITIVE finding never
 * observed (an absence of information presented as information). Never throws.
 */
export async function readServiceWorkerState(
  nav: Navigator | undefined = typeof navigator !== "undefined" ? navigator : undefined,
): Promise<string> {
  try {
    if (!nav || !("serviceWorker" in nav)) return "unsupported";
    const controller = nav.serviceWorker.controller;
    const ctrlPart = controller ? `ctrl:${controller.state}` : "ctrl:none";
    // Sentinel — must be overwritten by EITHER a successful read (→ a concrete
    // reg:… incl. reg:none for a genuine undefined) OR the reject path (→ reg:unknown).
    let regPart = "reg:unknown";
    try {
      const reg = await nav.serviceWorker.getRegistration();
      if (reg) {
        if (reg.installing) regPart = `reg:installing:${reg.installing.state}`;
        else if (reg.waiting) regPart = `reg:waiting:${reg.waiting.state}`;
        else if (reg.active) regPart = `reg:active:${reg.active.state}`;
        else regPart = "reg:registered";
      } else {
        // Successful call, undefined result → CONFIRMED no registration.
        regPart = "reg:none";
      }
    } catch {
      // Could-not-ask (getRegistration rejected) → UNKNOWN, never reg:none.
      regPart = "reg:unknown";
    }
    return `${regPart};${ctrlPart}`;
  } catch {
    return "unknown";
  }
}

/**
 * Coarse, non-reversible byte-size bucket — mirrors the sidecar/proxy
 * `sizeClass`. Used by the pre-POST phase emitter so a raw byte count never
 * reaches a log line (dl-12467: exact size is a content side-channel; the
 * bucket carries none of it). Same bucket tokens the server allowlists.
 */
export function clientSizeClass(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1024) return "<1KiB";
  if (n < 16 * 1024) return "1-16KiB";
  if (n < 256 * 1024) return "16-256KiB";
  if (n < 4 * 1024 * 1024) return "256KiB-4MiB";
  return ">=4MiB";
}

/** Derive the telemetry endpoint from the transcribe endpoint (same base). */
function telemetryEndpointFor(transcribeEndpoint: string): string {
  return transcribeEndpoint.replace(/\/transcribe(\?.*)?$/, "/telemetry");
}

/**
 * Fire-and-forget PRIVACY-SAFE phase telemetry (T2/T3). Records
 * phase/outcome/size-CLASS + identity headers — NEVER a transcript, audio,
 * or an exact byte count. Critically covers the PRE-POST short-blob case,
 * which never reaches /transcribe, so the operator's actual failure mode
 * (a sub-1KiB blob → nothing sent) finally emits a distinct signal instead
 * of nothing. Uses `keepalive` so it survives an immediate teardown; all
 * errors are swallowed (telemetry must never affect the UX path).
 */
export function emitVoicePhase(
  transcribeEndpoint: string,
  outcome: "short-blob" | "no-speech" | "empty-response",
  sizeClass: string,
  phase: "pre-post" | "client" = "pre-post",
): void {
  try {
    if (typeof fetch === "undefined") return;
    // Resolve SW state (async) THEN fire; swallow everything — telemetry is
    // best-effort and must never affect the UX path or surface an error.
    void (async () => {
      const swState = await readServiceWorkerState();
      await fetch(telemetryEndpointFor(transcribeEndpoint), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-voice-client-build": readClientBuildId(),
          "x-voice-sw-state": swState,
        },
        body: JSON.stringify({ phase, outcome, sizeClass }),
        keepalive: true,
      });
    })().catch(() => {
      /* telemetry is best-effort; never surface to the UX */
    });
  } catch {
    /* defensive */
  }
}

/** Emit the coordinated stop reason without payload or exact byte length. */
export function emitRecordingStopped(
  transcribeEndpoint: string,
  sizeClass: string,
  stopReason: VoiceStopReason,
  requestId: string,
): void {
  try {
    if (typeof fetch === "undefined") return;
    void (async () => {
      const swState = await readServiceWorkerState();
      await fetch(telemetryEndpointFor(transcribeEndpoint), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-voice-client-build": readClientBuildId(),
          "x-voice-sw-state": swState,
        },
        body: JSON.stringify({
          phase: "client",
          outcome: "recording-stopped",
          sizeClass,
          stopReason,
          requestId,
        }),
        keepalive: true,
      });
    })().catch(() => {
      /* telemetry is best-effort; never surface to the UX */
    });
  } catch {
    /* defensive */
  }
}

type ButtonPhase = "idle" | "recording" | "uploading" | "interrupted" | "error";

/**
 * Vector glyphs for the five button phases (replaces the pre-2026-06-28 emoji
 * 🎤/🔴/⏳ which, being full-color glyphs, ignored `style.color` and read as a
 * skeuomorphic sticker in the otherwise flat-vector composer). Inline Material
 * path data (no `@mdi` dependency — keeps the workspace plugin dependency-light;
 * the host client owns `@mdi/js` but the plugin must stay portable). Each `<path>`
 * uses `fill="currentColor"` so the glyph finally inherits the theme-token color
 * driven by `style.color` below.
 *
 *   idle      → mic outline      (ghost, var(--text-secondary))
 *   recording → mic filled       (var(--accent-primary) + calm pulse ring)
 *   uploading → loading arc       (var(--text-secondary) + spin)
 *   interrupted → stop square     (var(--accent-yellow))
 *   error       → alert circle    (var(--accent-red))
 */
const ICON_PATHS: Record<ButtonPhase, string> = {
  idle: "M17.3,11C17.3,14 14.76,16.1 12,16.1C9.24,16.1 6.7,14 6.7,11H5C5,14.41 7.72,17.23 11,17.72V21H13V17.72C16.28,17.23 19,14.41 19,11M10.8,4.9C10.8,4.24 11.34,3.7 12,3.7C12.66,3.7 13.2,4.24 13.2,4.9L13.19,11.1C13.19,11.76 12.66,12.3 12,12.3C11.34,12.3 10.8,11.76 10.8,11.1M12,14A3,3 0 0,0 15,11V5A3,3 0 0,0 12,2A3,3 0 0,0 9,5V11A3,3 0 0,0 12,14Z",
  recording:
    "M12,2A3,3 0 0,1 15,5V11A3,3 0 0,1 12,14A3,3 0 0,1 9,11V5A3,3 0 0,1 12,2M19,11C19,14.53 16.39,17.44 13,17.93V21H11V17.93C7.61,17.44 5,14.53 5,11H7A5,5 0 0,0 12,16A5,5 0 0,0 17,11H19Z",
  uploading: "M12,4V2A10,10 0 0,0 2,12H4A8,8 0 0,1 12,4Z",
  interrupted: "M6,6H18V18H6V6Z",
  error:
    "M11,15H13V17H11V15M11,7H13V13H11V7M12,2C6.47,2 2,6.5 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M12,20A8,8 0 0,1 4,12A8,8 0 0,1 12,4A8,8 0 0,1 20,12A8,8 0 0,1 12,20Z",
};

/**
 * Scoped keyframes for the spinner (uploading) and the calm accent record-ring
 * (recording). Kept inside the component output so the portable plugin carries
 * its own motion — it does not rely on the host's Tailwind `animate-spin` being
 * emitted. `prefers-reduced-motion` disables both (the `!important` beats the
 * inline `animation` shorthand on the targeted elements).
 */
const PTT_KEYFRAMES = `
@keyframes ptt-spin { to { transform: rotate(360deg); } }
@keyframes ptt-ring {
  0%   { transform: scale(0.9); opacity: 0.55; }
  100% { transform: scale(1.6); opacity: 0; }
}
@media (prefers-reduced-motion: reduce) {
  [data-testid="ptt-icon"],
  [data-testid="ptt-pulse-ring"] { animation: none !important; }
}
`;

export interface PushToTalkButtonProps {
  onTranscript: (transcript: string) => void;
  endpoint?: string;
  healthEndpoint?: string;
  disabled?: boolean;
  className?: string;
  /**
   * Title prefix shown when the button is idle. Default
   * "Click to record voice (click again to stop)".
   */
  idleTitle?: string;
  /**
   * Optional listener fired when the underlying MediaStream is created
   * (recording start) and torn down (recording stop). Consumers (e.g.
   * MobileComposer audio-wave canvas) use this to render a live waveform
   * while the user is recording.
   */
  onStreamChange?: (stream: MediaStream | null) => void;
}

function deriveLabel(
  phase: ButtonPhase,
  errorMessage: string | null,
  interruptedStopReason: VoiceStopReason | null,
  interruptionDetail: InterruptionDetail | null,
  sidecarHealthy: boolean,
  idleTitle: string
): { title: string; ariaLabel: string } {
  if (phase === "recording") {
    return {
      title: "Recording… (click to stop and transcribe)",
      ariaLabel: "Stop recording and transcribe",
    };
  }
  if (phase === "uploading") {
    return {
      title: "Transcribing…",
      ariaLabel: "Transcribing voice — please wait",
    };
  }
  if (phase === "interrupted" && interruptedStopReason && interruptionDetail) {
    const reason = interruptedReasonText(interruptedStopReason, interruptionDetail);
    const title = `Recording interrupted. ${reason} Tap the microphone to dismiss.`;
    return { title, ariaLabel: title };
  }
  if (phase === "error" && errorMessage) {
    return { title: errorMessage, ariaLabel: errorMessage };
  }
  if (!sidecarHealthy) {
    return {
      title: "Voice service starting… (click to record)",
      ariaLabel: "Voice service starting",
    };
  }
  return { title: idleTitle, ariaLabel: idleTitle };
}

export function PushToTalkButton({
  onTranscript,
  endpoint = DEFAULT_ENDPOINT,
  healthEndpoint = DEFAULT_HEALTH,
  disabled = false,
  className,
  idleTitle = "Click to record voice (click again to stop)",
  onStreamChange,
}: PushToTalkButtonProps) {
  const [phase, setPhase] = useState<ButtonPhase>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [interruptedStopReason, setInterruptedStopReason] = useState<VoiceStopReason | null>(null);
  const [interruptionDetail, setInterruptionDetail] = useState<InterruptionDetail | null>(null);
  const [sidecarHealthy, setSidecarHealthy] = useState<boolean>(true);
  const interruptedMessageId = useId();

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const safetyNetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const errorClearRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopReasonRef = useRef<VoiceStopReason>(VoiceStopReason.ManualStop);
  const requestIdRef = useRef<string | null>(null);
  const stopInitiatedRef = useRef<boolean>(false);

  // Click-vs-press race-fix refs (Risk #12 / 2026-05-13).
  // When the user *clicks* the button (vs press-and-hold legacy UX),
  // a second click may arrive before `getUserMedia` resolves the first
  // start. `inFlightStartRef` marks the window; `pendingStopRef` queues
  // the stop intent so it can be flushed once start completes. The same
  // race-shape persists under click-to-toggle (consecutive clicks); the
  // queued-stop flush mechanism is preserved.
  const inFlightStartRef = useRef<boolean>(false);
  const pendingStopRef = useRef<boolean>(false);

  // Latest-ref for stopRecording so the safety-net timer + queued-stop
  // flush can invoke the current callback without TDZ forward-ref issues.
  const stopRecordingRef = useRef<
    ((stopReason: VoiceStopReason, forceCancel?: boolean) => void) | null
  >(null);

  // Latest-ref for onStreamChange so we can fire it from start/stop paths
  // without re-creating those useCallbacks when the consumer's listener
  // identity changes between renders.
  const onStreamChangeRef = useRef<typeof onStreamChange>(onStreamChange);
  useEffect(() => {
    onStreamChangeRef.current = onStreamChange;
  }, [onStreamChange]);

  // Sidecar health poll. While unhealthy, the button is visually disabled
  // and the title surfaces "Voice service starting…". Operator-empirical
  // 2026-05-13: cold-start sidecar takes ~3-6s.
  useEffect(() => {
    let cancelled = false;
    const probe = async () => {
      try {
        const res = await fetch(healthEndpoint, { method: "GET" });
        if (cancelled) return;
        setSidecarHealthy(res.ok);
      } catch {
        if (cancelled) return;
        setSidecarHealthy(false);
      }
    };
    probe();
    const id = setInterval(probe, SIDECAR_HEALTH_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [healthEndpoint]);

  // Error auto-clear after 6s.
  useEffect(() => {
    if (phase !== "error") return;
    errorClearRef.current = setTimeout(() => {
      setPhase("idle");
      setErrorMessage(null);
    }, ERROR_AUTO_CLEAR_MS);
    return () => {
      if (errorClearRef.current) clearTimeout(errorClearRef.current);
    };
  }, [phase]);

  const cleanupRecorder = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      try {
        recorderRef.current.stop();
      } catch {
        /* defensive */
      }
    }
    if (streamRef.current) {
      try {
        streamRef.current.getTracks().forEach((t) => t.stop());
      } catch {
        /* defensive */
      }
      streamRef.current = null;
      onStreamChangeRef.current?.(null);
      recorderRef.current = null;
    }
    chunksRef.current = [];
    stopInitiatedRef.current = false;
    requestIdRef.current = null;
    if (safetyNetRef.current) {
      clearTimeout(safetyNetRef.current);
      safetyNetRef.current = null;
    }
  }, []);

  const stopRecording = useCallback((
    stopReason: VoiceStopReason = VoiceStopReason.ManualStop,
    forceCancel: boolean = false,
  ) => {
    if (!recorderRef.current) return;
    if (recorderRef.current.state === "inactive") return;
    if (stopInitiatedRef.current) return;
    stopInitiatedRef.current = true;
    stopReasonRef.current = stopReason;
    if (forceCancel) {
      // User-cancel path: discard chunks; do not upload.
      chunksRef.current = [];
    }
    try {
      recorderRef.current.stop();
    } catch {
      stopInitiatedRef.current = false;
      /* defensive */
    }
  }, []);

  // Sync stopRecording into the latest-ref so `startRecording` can invoke it
  // from the safety-net timer + queued-stop flush without a TDZ forward-ref.
  useEffect(() => {
    stopRecordingRef.current = stopRecording;
  }, [stopRecording]);

  const uploadBlob = useCallback(async (
    blob: Blob,
    stopReason: VoiceStopReason,
    requestId: string,
  ) => {
    setPhase("uploading");
    try {
      const form = new FormData();
      form.append("audio", blob, "recording.webm");
      // Criterion 10: stamp identity-only telemetry headers so the server can
      // record WHICH bundle + SW state produced this request. No payload.
      // SW state is async (registration lifecycle needs getRegistration()).
      const swState = await readServiceWorkerState();
      const res = await fetch(endpoint, {
        method: "POST",
        body: form,
        headers: {
          "x-voice-client-build": readClientBuildId(),
          "x-voice-sw-state": swState,
          "x-voice-stop-reason": stopReason,
          "x-voice-request-id": requestId,
        },
      });
      if (!res.ok) {
        // Distinguish the backend's typed "no speech" (422) from other errors.
        // The sidecar returns {type:"EmptyTranscriptError"} on 422; the proxy
        // returns {type:"EmptyUpstreamTranscript"} on a 502 defense trip. Both
        // mean "the service produced no text" — NEVER "your recording was too
        // short". Parse defensively; fall back to a generic HTTP error.
        let parsedType: string | undefined;
        let bodyText = "";
        try {
          bodyText = await res.text();
          parsedType = (JSON.parse(bodyText) as { type?: string }).type;
        } catch {
          /* non-JSON error body; keep bodyText for the generic path */
        }
        if (res.status === 422 && parsedType === "EmptyTranscriptError") {
          emitVoicePhase(endpoint, "no-speech", clientSizeClass(blob.size), "client");
          throw new Error(VOICE_MESSAGES.NO_SPEECH);
        }
        if (parsedType === "EmptyUpstreamTranscript") {
          emitVoicePhase(endpoint, "empty-response", clientSizeClass(blob.size), "client");
          throw new Error(VOICE_MESSAGES.EMPTY_RESPONSE);
        }
        throw new Error(`HTTP ${res.status}: ${bodyText || res.statusText}`);
      }
      const data = await res.json() as { transcript?: string };
      // T4 — byte-identical insertion. `.trim()` may ONLY validate emptiness;
      // the EXACT RAW sidecar bytes must reach onTranscript unchanged. A
      // whitespace-bearing transcript (" привет ") is non-empty and must be
      // inserted verbatim — normalizing it here would silently corrupt the
      // working path, which an unpadded test can't catch.
      const raw = typeof data.transcript === "string" ? data.transcript : "";
      if (raw.trim().length === 0) {
        // Defense-in-depth: a 200 that still carries an empty (or whitespace-
        // only) transcript (a stale sidecar/proxy). Service fault — do NOT
        // blame the operator's recording duration (that is SHORT_BLOB only).
        emitVoicePhase(endpoint, "empty-response", clientSizeClass(blob.size), "client");
        throw new Error(VOICE_MESSAGES.EMPTY_RESPONSE);
      }
      onTranscript(raw);
      if (stopReason === VoiceStopReason.ManualStop) {
        setInterruptedStopReason(null);
        setInterruptionDetail(null);
        setPhase("idle");
      } else {
        setInterruptedStopReason(stopReason);
        setInterruptionDetail("partial-transcript");
        setPhase("interrupted");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setInterruptedStopReason(null);
      setInterruptionDetail(null);
      setErrorMessage(msg);
      setPhase("error");
    }
  }, [endpoint, onTranscript]);

  const startRecording = useCallback(async () => {
    if (disabled) return;
    if (phase === "recording" || phase === "uploading") return;
    if (inFlightStartRef.current) return;
    inFlightStartRef.current = true;
    pendingStopRef.current = false;

    if (typeof navigator === "undefined") {
      setErrorMessage("Browser context unavailable");
      setPhase("error");
      inFlightStartRef.current = false;
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      onStreamChangeRef.current?.(stream);

      // Race-fix: if user clicked again while getUserMedia was pending,
      // honour the queued-stop intent immediately + tear everything down.
      if (pendingStopRef.current) {
        pendingStopRef.current = false;
        inFlightStartRef.current = false;
        try {
          stream.getTracks().forEach((t) => t.stop());
        } catch {
          /* defensive */
        }
        streamRef.current = null;
        onStreamChangeRef.current?.(null);
        return;
      }

      const recordingRequestId = createVoiceRequestId();
      requestIdRef.current = recordingRequestId;
      stopReasonRef.current = VoiceStopReason.ManualStop;
      stopInitiatedRef.current = false;
      setInterruptedStopReason(null);
      setInterruptionDetail(null);
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        // iOS 18.7+ Safari WebKit MediaRecorder produces audio/mp4 (ISO BMFF container
        // starts with 0x00 0x00 0x00 NN ftyp...), not audio/webm. Hardcoding "audio/webm"
        // here caused the sidecar's ffmpeg -f webm decoder to fail with "EBML header
        // parsing failed 0x00 at pos 0" because the bytes are not actually webm/EBML.
        // Sister-shape to _serve.py:122 x- prefix normalization (pre-existing iOS defense).
        // recorder.mimeType returns the actual format MediaRecorder negotiated with the
        // browser engine (e.g., "audio/mp4" on iOS Safari, "audio/webm;codecs=opus" on
        // Chrome). Empirical root-cause traced via ~/.pi/logs/voice-sidecar.err 2026-05-30.
        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || "audio/webm",
        });
        const completedStopReason = stopReasonRef.current;
        const completedRequestId = recordingRequestId;
        emitRecordingStopped(
          endpoint,
          clientSizeClass(blob.size),
          completedStopReason,
          completedRequestId,
        );
        if (streamRef.current) {
          try {
            streamRef.current.getTracks().forEach((t) => t.stop());
          } catch {
            /* defensive */
          }
          streamRef.current = null;
          onStreamChangeRef.current?.(null);
          recorderRef.current = null;
        }
        if (safetyNetRef.current) {
          clearTimeout(safetyNetRef.current);
          safetyNetRef.current = null;
        }
        const automaticStop = completedStopReason !== VoiceStopReason.ManualStop;
        if (automaticStop && blob.size < 1024) {
          // Reason FIRST: an automatic stop owns this outcome. It must never
          // fall through to the operator-directed "Recording too short" error
          // or that error's six-second auto-clear timer.
          emitVoicePhase(endpoint, "short-blob", clientSizeClass(blob.size));
          setErrorMessage(null);
          setInterruptedStopReason(completedStopReason);
          setInterruptionDetail("too-brief-to-transcribe");
          setPhase("interrupted");
        } else if (blob.size < 1024) {
          // Pre-POST short-blob: nothing was ever sent. Duration IS the cause
          // here — this is the ONLY place that language is honest. Distinct
          // from the backend-empty states surfaced in uploadBlob.
          // T2/T3: emit a privacy-safe PRE-POST phase signal — this path never
          // reaches /transcribe, so without this the operator's actual failure
          // mode emits nothing. Size-CLASS only, never the raw byte count.
          emitVoicePhase(endpoint, "short-blob", clientSizeClass(blob.size));
          setInterruptedStopReason(null);
          setInterruptionDetail(null);
          setErrorMessage(VOICE_MESSAGES.SHORT_BLOB);
          setPhase("error");
        } else {
          void uploadBlob(blob, completedStopReason, completedRequestId);
        }
      };
      recorder.start();
      setPhase("recording");

      // 10min safety-net.
      safetyNetRef.current = setTimeout(() => {
        const fn = stopRecordingRef.current;
        if (fn) fn(VoiceStopReason.SafetyNetAutoStop);
      }, MAX_RECORDING_MS);
    } catch (e) {
      const msg =
        e instanceof Error && e.name === "NotAllowedError"
          ? "Microphone permission denied"
          : e instanceof Error
          ? e.message
          : "Unable to access microphone";
      setErrorMessage(msg);
      setPhase("error");
    } finally {
      inFlightStartRef.current = false;
    }
  }, [disabled, phase, uploadBlob]);

  const onClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      if (phase === "recording" || inFlightStartRef.current) {
        if (inFlightStartRef.current && phase !== "recording") {
          // Queued-stop: flush in startRecording's post-getUserMedia branch.
          pendingStopRef.current = true;
          return;
        }
        stopRecording(VoiceStopReason.ManualStop);
        return;
      }
      if (phase === "uploading") return;
      if (phase === "interrupted") {
        setInterruptedStopReason(null);
        setInterruptionDetail(null);
        setErrorMessage(null);
        setPhase("idle");
        return;
      }
      if (phase === "error") {
        setPhase("idle");
        setErrorMessage(null);
        return;
      }
      if (!sidecarHealthy) return;
      void startRecording();
    },
    [phase, sidecarHealthy, startRecording, stopRecording]
  );

  // Visibility-change auto-stop. Operator-empirical: forgotten recordings
  // drained battery on iOS PWA when tab was backgrounded.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden" && phase === "recording") {
        stopRecording(VoiceStopReason.VisibilityAutoStop);
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [phase, stopRecording]);

  // Unmount cleanup.
  useEffect(() => {
    return () => {
      cleanupRecorder();
      if (errorClearRef.current) clearTimeout(errorClearRef.current);
    };
  }, [cleanupRecorder]);

  const { title, ariaLabel } = deriveLabel(
    phase,
    errorMessage,
    interruptedStopReason,
    interruptionDetail,
    sidecarHealthy,
    idleTitle
  );
  const isRecording = phase === "recording";
  const interruptedReason =
    phase === "interrupted" && interruptedStopReason && interruptionDetail
      ? interruptedReasonText(interruptedStopReason, interruptionDetail)
      : null;

  const buttonClass =
    className ??
    "p-2 min-h-[44px] min-w-[44px] flex items-center justify-center bg-[var(--bg-tertiary)] rounded-lg hover:bg-[var(--bg-hover)] transition-colors";

  const style: CSSProperties = {
    // Glyphs inherit this via currentColor. Recording reads CALM
    // (var(--accent-primary)) — terracotta on editorial, blue on dark — never an
    // alarming red. Tokens resolve per active skin in client/src/index.css.
    position: "relative",
    color: isRecording
      ? "var(--accent-primary)"
      : phase === "uploading"
      ? "var(--text-secondary)"
      : phase === "error"
      ? "var(--accent-red)"
      : phase === "interrupted"
      ? "var(--accent-yellow)"
      : "var(--text-secondary)",
  };

  return (
    <div className="relative self-end">
      {interruptedReason && (
        <div
          id={interruptedMessageId}
          role="status"
          aria-live="polite"
          aria-atomic="true"
          data-testid="ptt-interrupted-message"
          style={{
            position: "absolute",
            right: 0,
            bottom: "calc(100% + 8px)",
            zIndex: 20,
            boxSizing: "border-box",
            width: "max-content",
            maxWidth: "min(220px, calc(100vw - 24px))",
            padding: "8px 10px",
            border: "1px solid var(--accent-yellow)",
            borderRadius: "8px",
            background: "var(--bg-surface)",
            color: "var(--text-primary)",
            boxShadow: "0 6px 18px var(--shadow-card)",
            fontFamily: "inherit",
            fontSize: "12px",
            lineHeight: 1.4,
            textAlign: "left",
            whiteSpace: "normal",
            pointerEvents: "none",
          }}
        >
          <strong
            style={{
              display: "block",
              marginBottom: "2px",
              color: "var(--accent-yellow)",
              fontWeight: 650,
            }}
          >
            Recording interrupted
          </strong>
          <span>{interruptedReason}</span>{" "}
          <span style={{ color: "var(--text-secondary)" }}>Tap the microphone to dismiss.</span>
        </div>
      )}
      <button
        type="button"
        onClick={onClick}
        disabled={disabled || (phase === "idle" && !sidecarHealthy)}
        className={buttonClass}
        title={title}
        aria-label={ariaLabel}
        aria-describedby={interruptedReason ? interruptedMessageId : undefined}
        aria-pressed={isRecording}
        data-testid="push-to-talk"
        data-phase={phase}
        data-stop-reason={phase === "interrupted" ? interruptedStopReason ?? undefined : undefined}
        data-interruption-detail={phase === "interrupted" ? interruptionDetail ?? undefined : undefined}
        style={style}
      >
        <style>{PTT_KEYFRAMES}</style>
        {/* Calm accent record-ring — vector, themed via currentColor, gentle
            expand-fade. Replaces the alarming red 🔴 emoji. Recording only. */}
        {isRecording && (
          <span
            aria-hidden
            data-testid="ptt-pulse-ring"
            style={{
              position: "absolute",
              inset: "-3px",
              borderRadius: "9999px",
              border: "2px solid currentColor",
              opacity: 0.55,
              animation: "ptt-ring 1.6s ease-out infinite",
              pointerEvents: "none",
            }}
          />
        )}
        {/* Vector glyph — single Material mic family, inherits currentColor so it
            finally respects the theme token in `style.color` above. */}
        <svg
          aria-hidden
          data-testid="ptt-icon"
          data-icon-phase={phase}
          viewBox="0 0 24 24"
          width="20"
          height="20"
          style={
            phase === "uploading"
              ? { display: "block", animation: "ptt-spin 0.9s linear infinite" }
              : { display: "block" }
          }
        >
          <path fill="currentColor" d={ICON_PATHS[phase]} />
        </svg>
      </button>
    </div>
  );
}
