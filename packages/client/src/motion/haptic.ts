import { isCapacitorNative } from "../utils/platform.js";

/**
 * Haptic feedback — written Capacitor-aware NOW (even though the app is web-only
 * today) so the Phase-B Capacitor wrap lights up real iOS haptics for free with
 * zero code change here.
 *
 * Resolution order per call:
 *   1. Capacitor Haptics plugin  — when `isCapacitorNative()` AND the plugin is
 *      present on `window.Capacitor`. Real iOS/Android taptic engine.
 *   2. `navigator.vibrate`       — Android Chrome / some PWAs. Coarse but real.
 *   3. silent no-op              — iOS Safari/PWA (no web haptic API exists).
 *
 * Kinds map to intent, not to a specific waveform:
 *   selection — light tick on a discrete choice / press (the common case)
 *   impact    — a firmer single thud for a committing primary action
 *   success   — a short double-pulse for "it happened" (send delivered)
 *   warning   — a longer buzz for a destructive / attention action
 */
export type HapticKind = "selection" | "impact" | "success" | "warning";

/** navigator.vibrate fallback patterns (ms). Tuned light — these are PWA-coarse. */
const VIBRATE_PATTERN: Record<HapticKind, number | number[]> = {
  selection: 6,
  impact: 12,
  success: [8, 30, 8],
  warning: [16, 40, 16],
};

/** Capacitor Haptics ImpactStyle / NotificationType mapping. */
const CAP_IMPACT: Record<"selection" | "impact", string> = {
  selection: "Light",
  impact: "Medium",
};
const CAP_NOTIFY: Record<"success" | "warning", string> = {
  success: "SUCCESS",
  warning: "WARNING",
};

interface CapacitorHaptics {
  impact?: (opts: { style: string }) => void;
  notification?: (opts: { type: string }) => void;
  selectionStart?: () => void;
}

function capacitorHaptics(): CapacitorHaptics | null {
  if (!isCapacitorNative()) return null;
  const cap = (window as { Capacitor?: { Plugins?: { Haptics?: CapacitorHaptics } } }).Capacitor;
  return cap?.Plugins?.Haptics ?? null;
}

/**
 * Fire a haptic of the given intent. Never throws — a missing API or a plugin
 * error degrades silently to the next strategy (and ultimately to a no-op), so
 * call sites can fire-and-forget on every press without guards.
 */
export function haptic(kind: HapticKind = "selection"): void {
  try {
    const cap = capacitorHaptics();
    if (cap) {
      if (kind === "selection" || kind === "impact") {
        cap.impact?.({ style: CAP_IMPACT[kind] });
      } else {
        cap.notification?.({ type: CAP_NOTIFY[kind] });
      }
      return;
    }
  } catch {
    /* fall through to vibrate */
  }

  try {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      navigator.vibrate(VIBRATE_PATTERN[kind]);
    }
  } catch {
    /* silent no-op (iOS Safari / unsupported) */
  }
}
