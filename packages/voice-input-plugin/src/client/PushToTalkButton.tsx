/**
 * PushToTalkButton — click-to-toggle voice-input microphone button for
 * pi-dashboard's CommandInput.
 *
 * UX (per operator-direct ratification 2026-05-14 ~12:55 CEST: "so, on the
 * voice input - can we switch to click?" — operator-verbatim per Pattern 87):
 *
 *   idle  --click-->  recording  --click-->  uploading  -->  idle
 *
 * On second click while `recording`, the in-flight MediaRecorder is stopped,
 * the captured Blob is POSTed to `endpoint`, the transcript is appended to
 * the consumer's input field via `onTranscript`, and the button returns to
 * idle. State `error` auto-recovers to idle after 6s OR on next click.
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

type ButtonPhase = "idle" | "recording" | "uploading" | "error";

/**
 * Vector glyphs for the four button phases (replaces the pre-2026-06-28 emoji
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
 *   error     → alert circle      (var(--accent-red))
 */
const ICON_PATHS: Record<ButtonPhase, string> = {
  idle: "M17.3,11C17.3,14 14.76,16.1 12,16.1C9.24,16.1 6.7,14 6.7,11H5C5,14.41 7.72,17.23 11,17.72V21H13V17.72C16.28,17.23 19,14.41 19,11M10.8,4.9C10.8,4.24 11.34,3.7 12,3.7C12.66,3.7 13.2,4.24 13.2,4.9L13.19,11.1C13.19,11.76 12.66,12.3 12,12.3C11.34,12.3 10.8,11.76 10.8,11.1M12,14A3,3 0 0,0 15,11V5A3,3 0 0,0 12,2A3,3 0 0,0 9,5V11A3,3 0 0,0 12,14Z",
  recording:
    "M12,2A3,3 0 0,1 15,5V11A3,3 0 0,1 12,14A3,3 0 0,1 9,11V5A3,3 0 0,1 12,2M19,11C19,14.53 16.39,17.44 13,17.93V21H11V17.93C7.61,17.44 5,14.53 5,11H7A5,5 0 0,0 12,16A5,5 0 0,0 17,11H19Z",
  uploading: "M12,4V2A10,10 0 0,0 2,12H4A8,8 0 0,1 12,4Z",
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
  const [sidecarHealthy, setSidecarHealthy] = useState<boolean>(true);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const safetyNetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const errorClearRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
  const stopRecordingRef = useRef<((forceCancel: boolean) => void) | null>(null);

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
    if (safetyNetRef.current) {
      clearTimeout(safetyNetRef.current);
      safetyNetRef.current = null;
    }
  }, []);

  const stopRecording = useCallback((forceCancel: boolean = false) => {
    if (!recorderRef.current) return;
    if (recorderRef.current.state === "inactive") return;
    if (forceCancel) {
      // User-cancel path: discard chunks; do not upload.
      chunksRef.current = [];
    }
    try {
      recorderRef.current.stop();
    } catch {
      /* defensive */
    }
  }, []);

  // Sync stopRecording into the latest-ref so `startRecording` can invoke it
  // from the safety-net timer + queued-stop flush without a TDZ forward-ref.
  useEffect(() => {
    stopRecordingRef.current = stopRecording;
  }, [stopRecording]);

  const uploadBlob = useCallback(async (blob: Blob) => {
    setPhase("uploading");
    try {
      const form = new FormData();
      form.append("audio", blob, "recording.webm");
      const res = await fetch(endpoint, { method: "POST", body: form });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status}: ${body || res.statusText}`);
      }
      const data = await res.json() as { transcript?: string };
      const transcript = (data.transcript || "").trim();
      if (!transcript) {
        throw new Error("Recording too short (click and wait longer)");
      }
      onTranscript(transcript);
      setPhase("idle");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
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
        if (blob.size < 1024) {
          setErrorMessage("Recording too short (click and wait longer)");
          setPhase("error");
        } else {
          void uploadBlob(blob);
        }
      };
      recorder.start();
      setPhase("recording");

      // 10min safety-net.
      safetyNetRef.current = setTimeout(() => {
        const fn = stopRecordingRef.current;
        if (fn) fn(false);
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
        stopRecording(false);
        return;
      }
      if (phase === "uploading") return;
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
        stopRecording(false);
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
    sidecarHealthy,
    idleTitle
  );
  const isRecording = phase === "recording";

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
      : "var(--text-secondary)",
  };

  return (
    <div className="relative self-end">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled || (phase === "idle" && !sidecarHealthy)}
        className={buttonClass}
        title={title}
        aria-label={ariaLabel}
        aria-pressed={isRecording}
        data-testid="push-to-talk"
        data-phase={phase}
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
