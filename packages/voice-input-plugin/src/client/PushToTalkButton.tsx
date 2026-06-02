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
 *   - Risk #12 20-min safety-net (`MAX_RECORDING_MS = 1_200_000`): auto-stop
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
 * 20-min safety-net auto-stop (Risk #12 per voice-input-substrate-r1 ship).
 * Under click-to-toggle this safety-net is load-bearing because there is no
 * `pointerup` natural-cancel path; a forgotten second click would otherwise
 * leave the mic hot indefinitely.
 *
 * Cap raised from 60_000 (1 min) to 1_200_000 (20 min) per cell
 * voice-input-20min-reliability/v1 W5 (operator-direct 2026-05-31 ~15:30 CEST:
 * "I want to be able to post for like, or to talk for 20 minutes at a time,
 * and it should work reliably"). The previous 1-min cap was a substrate-r1
 * recovery baseline (FastUnion edit 2026-05-17 had raised to 300_000 without
 * updating the test); this change raises the cap and updates the test in the
 * same commit per Schema 5 § 3.9 4-point anti-recurrence rule.
 *
 * History (lineage): 60_000 (substrate-r1 baseline) → 300_000 (FastUnion
 * 2026-05-17, test-not-updated) → 60_000 (FastUnion-recovery restore) →
 * 1_200_000 (THIS change; W5 cell-DONE SAME-COMMIT with test + comment).
 *
 * Sister-mitigation: `recorder.start(30_000)` timeslice below at start-call
 * site mitigates Mech-6 (chunksRef Blob accumulation without timeslice) per
 * W3 retro-test PASS evidence (cell voice-input-20min-reliability/v1 W3
 * result; WebKit bugs 276536 + 279432 canonical-justify timeslice canonical).
 * 21min30s raw-MediaRecorder canary completed full duration with no upstream
 * cap fired (W3 _w3-playwright-ios-reliability-result.md § Mechanism 2).
 */
const MAX_RECORDING_MS = 1_200_000;

const SIDECAR_HEALTH_POLL_INTERVAL_MS = 5_000;
const ERROR_AUTO_CLEAR_MS = 6_000;

type ButtonPhase = "idle" | "recording" | "uploading" | "error";

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
      // Timeslice 30_000 ms: emit `ondataavailable` chunks every 30 s rather
      // than buffering a single Blob for the full 20-min recording. Mitigates
      // Mech-6 (chunksRef Blob accumulation without timeslice) per W3 retro-
      // test (WebKit bugs 276536 + 279432 canonical-justify timeslice).
      recorder.start(30_000);
      setPhase("recording");

      // 20-min safety-net (see MAX_RECORDING_MS comment above).
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
    color: isRecording
      ? "var(--accent-error, #e74c3c)"
      : phase === "uploading"
      ? "var(--accent-warning, #f39c12)"
      : phase === "error"
      ? "var(--accent-error, #e74c3c)"
      : "var(--text-secondary, #888)",
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
        {phase === "uploading" ? (
          <span aria-hidden>⏳</span>
        ) : isRecording ? (
          <span aria-hidden>🔴</span>
        ) : (
          <span aria-hidden>🎤</span>
        )}
      </button>
    </div>
  );
}
