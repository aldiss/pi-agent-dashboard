/**
 * Legacy (pre-fix) behaviour fixtures — the RED reference for the five
 * able-to-fail voice controls, checked INTO the repo so every control runs in a
 * plain git-archive checkout with NO orchestration-state directory, NO alias
 * indirection, and NO second copy of the codebase present anywhere on disk.
 *
 * WHY THIS FILE EXISTS. A control must be able to FAIL to be worth anything. The
 * previous cycle demonstrated RED by aliasing an EXTERNAL frozen copy of the old
 * component/server (`candidate-*` / `matrix-*` aliases resolved into
 * ~/.pi/orchestration-state). A git archive of this repository contains none of
 * that, so those controls could never execute in a landing checkout — a fatal
 * fragility. These fixtures replace that indirection: each one reproduces, in a
 * few lines checked into the test tree, the SPECIFIC defective contract that the
 * fix corrects, so the same behavioural assertion that PASSES against the real
 * in-repo module (GREEN) FAILS against the fixture (RED). Import paths are
 * relative and in-repo only.
 *
 * FIDELITY. Each reproduction is excerpted from the genuine pre-fix baseline that
 * currently ships in the release (packages/voice-input-plugin/src, pre-fix
 * client/server). The pre-fix client has NO `interrupted` phase at all
 * (ButtonPhase = "idle" | "recording" | "uploading" | "error"), so an auto-
 * truncated recording surfaces as an ordinary red `error` — the exact
 * "looks like a plain error / says why" gap the fix closes. The fixtures encode
 * that contract, not an invented strawman.
 */
import React, { useEffect, useState } from "react";

/* ------------------------------------------------------------------ *
 * M1 / M2 — CLIENT: the pre-fix button had no distinct interrupted state.
 * An automatic stop rendered as the SAME red alert-circle as a plain error,
 * with the explanation (if any) only in a hover `title`, and the short-blob
 * case auto-cleared to idle after 6s. This fixture reproduces that contract:
 * one red glyph for both, ZERO rendered on-screen words, error auto-clears.
 * ------------------------------------------------------------------ */

const LEGACY_ALERT_CIRCLE =
  "M11,15H13V17H11V15M11,7H13V13H11V7M12,2C6.47,2 2,6.5 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M12,20A8,8 0 0,1 4,12A8,8 0 0,1 12,4A8,8 0 0,1 20,12A8,8 0 0,1 12,20Z";

type LegacyPhase = "idle" | "recording" | "uploading" | "error";

/**
 * `driveTo` lets a control put the fixture straight into the phase under test
 * without a MediaRecorder. `autoStopTruncated` models the pre-fix reality: an
 * automatic stop that yielded a truncated/tiny result was funnelled into the
 * SAME `error` phase (there was nowhere else for it to go), with the operator-
 * blaming "Recording too short" message and the 6s auto-clear.
 *
 * `errorMessage` overrides the error copy so a control can drive the fixture to
 * EACH distinct pre-fix error cause (SHORT_BLOB / NO_SPEECH / EMPTY_RESPONSE).
 * The point of the RED reference: whatever the cause, the pre-fix build put the
 * text ONLY in the hover `title`/`aria-label` and rendered ZERO on-screen words,
 * with an identical red alert-circle glyph — so on a touch device the three
 * causes are indistinguishable. `serviceStarting` models the other half of the
 * same class: pre-fix, a warming sidecar left the button in `idle` with the same
 * glyph/colour/zero words as ready, differing only in a bare `disabled`
 * attribute that carried no visible styling.
 */
export function LegacyPushToTalkButton({
  driveTo = "idle",
  autoStopTruncated = false,
  errorMessage,
  serviceStarting = false,
}: {
  driveTo?: LegacyPhase;
  autoStopTruncated?: boolean;
  errorMessage?: string;
  serviceStarting?: boolean;
}) {
  const [phase, setPhase] = useState<LegacyPhase>(driveTo);
  const [message, setMessage] = useState<string | null>(
    driveTo === "error"
      ? errorMessage ??
        (autoStopTruncated
          ? "Recording too short (click and wait longer)"
          : "Something went wrong")
      : null,
  );

  // Pre-fix: `error` auto-recovers to idle after 6s. (Modelled shorter here via
  // the same setTimeout shape; a control advances fake timers to observe it.)
  useEffect(() => {
    if (phase !== "error") return;
    const t = setTimeout(() => {
      setPhase("idle");
      setMessage(null);
    }, 6000);
    return () => clearTimeout(t);
  }, [phase]);

  const color = phase === "error" ? "var(--accent-red)" : "var(--text-secondary)";
  // The pre-fix component had no `interrupted` phase; `data-phase` never took
  // that value. The explanation lived only in the hover title/aria-label — for
  // BOTH the error family AND the warming-service state (title differs, pixels
  // do not).
  const title =
    message ??
    (serviceStarting ? "Voice service starting… (click to record)" : "Click to record voice");

  return (
    <button
      type="button"
      data-testid="push-to-talk"
      data-phase={phase}
      // Pre-fix: warming service set `disabled` with NO visible styling — the
      // resting `style` is identical to ready, so a touch user cannot see it.
      disabled={serviceStarting || undefined}
      title={title}
      aria-label={title}
      style={{ color }}
    >
      <svg data-testid="ptt-icon" data-icon-phase={phase} viewBox="0 0 24 24" width="20" height="20">
        <path
          fill="currentColor"
          d={
            phase === "error"
              ? LEGACY_ALERT_CIRCLE
              // idle/recording/uploading glyphs are irrelevant to the control;
              // the defect under test is that interrupted == error.
              : LEGACY_ALERT_CIRCLE
          }
        />
      </svg>
      {/* No ptt-interrupted-message / ptt-error-message / ptt-status-pill element
          ever rendered pre-fix — the cause was title-only, on every state. */}
    </button>
  );
}

/* ------------------------------------------------------------------ *
 * M3 — SERVER: pre-fix telemetry gate keyed on logger PRESENCE, not effective
 * level, via hasOwnProperty. Under a warn/silent parent the info line was sent
 * to `logger.info(...)` and dropped by pino with no console fallback → the
 * identity line vanished. Reproduced as the exact gate + emit shape.
 * ------------------------------------------------------------------ */
export function legacyEmitPhase(
  logger: { info?: (m: string) => void } | undefined,
  isLevelEnabled: ((lvl: string) => boolean) | undefined,
  message: string,
  sinks: { pino: (m: string) => void; console: (m: string) => void },
): void {
  // Pre-fix: `hasConfiguredLogger = !!logger && hasOwnProperty(logger,'info')`.
  const hasConfiguredLogger =
    !!logger && Object.prototype.hasOwnProperty.call(logger, "info");
  if (hasConfiguredLogger) {
    // Emitted to the configured logger at info; if the effective level is
    // above info (warn/silent) pino silently drops it — NO console fallback.
    if (isLevelEnabled && !isLevelEnabled("info")) return; // dropped, no fallback
    sinks.pino(message);
  } else {
    sinks.console(message);
  }
}

/* ------------------------------------------------------------------ *
 * M4 — SERVER: pre-fix transcribe GATED core function on telemetry metadata:
 * a half/malformed stop-reason/id pair returned 400 BEFORE upstream, so a
 * would-be-working transcription became a hard failure. Reproduced as the gate.
 * ------------------------------------------------------------------ */
const STOP_REASONS = new Set(["manual-stop", "visibility-auto-stop", "safety-net-auto-stop"]);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function legacyTranscribeGate(
  rawReason: string | undefined,
  rawId: string | undefined,
): { status: number } {
  const reasonMissing = rawReason === undefined;
  const idMissing = rawId === undefined;
  const legacyMissing = reasonMissing && idMissing;
  const reasonValid = typeof rawReason === "string" && STOP_REASONS.has(rawReason);
  const idValid = typeof rawId === "string" && UUID_V4.test(rawId);
  // Pre-fix acceptance boolean — telemetry metadata gates transcription.
  const ok = legacyMissing || (reasonValid && idValid);
  return { status: ok ? 200 : 400 };
}

/* ------------------------------------------------------------------ *
 * M5 — SERVER: pre-fix had NO onError/onResponse identity hook, so a pre-handler
 * framework rejection (413/415/404) produced no telemetry line at all. Modelled
 * as a "handler-only" logger that emits ONLY when the route handler runs.
 * ------------------------------------------------------------------ */
export function legacyPreHandlerIdentity(reachedHandler: boolean): { lines: number } {
  // Pre-fix: identity logged only inside the handler; pre-handler rejects skip it.
  return { lines: reachedHandler ? 1 : 0 };
}
