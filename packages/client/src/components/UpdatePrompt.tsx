import { m } from "motion/react";
import { useReducedMotion } from "motion/react";
import { Pressable } from "../motion/Pressable.js";
import { spring } from "../motion/springs.js";
import { useServiceWorkerUpdate } from "../hooks/useServiceWorkerUpdate.js";

/**
 * UpdatePrompt — the visible "Update ready — tap to refresh" pill.
 *
 * Appears when a new service worker has installed and is waiting (see
 * useServiceWorkerUpdate). Tapping it skip-waits the new SW and reloads onto the
 * fresh client. This is the operator-facing half of the PWA update fix: without
 * it the new SW would either swap silently (stale in-memory bundle) or wait
 * forever unseen.
 *
 * Slickness: the pill itself is a motion <Pressable> (press-scale + haptic,
 * reduced-motion-aware like the rest of the motion system) and springs in with
 * the `gentle` token. Filled-accent so it reads in BOTH skins. Anchored
 * bottom-center, raised to clear the chat command input — deliberately clear of
 * the top-center iOS InstallBanner and the top-right toast tray so it never
 * collides with either. Additive overlay — it touches no motion behavior-surface.
 */
export function UpdatePrompt() {
  const { updateReady, applyUpdate } = useServiceWorkerUpdate();
  const reduced = useReducedMotion() ?? false;

  if (!updateReady) return null;

  return (
    <div
      className="fixed inset-x-0 z-[60] flex justify-center pointer-events-none"
      style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 4.5rem)" }}
      aria-live="polite"
    >
      <m.div
        // Reduced-motion: render at rest (no travel/fade-in). Otherwise spring
        // up gently from below.
        initial={reduced ? false : { opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={reduced ? { duration: 0 } : spring.gentle}
        className="pointer-events-auto"
      >
        <Pressable
          onClick={applyUpdate}
          pressScale={0.97}
          haptic="selection"
          aria-label="Update ready — tap to refresh"
          className="flex items-center gap-2 rounded-full pl-3 pr-4 py-2 text-sm font-medium
                     bg-[var(--accent-primary)] text-white border border-black/10
                     shadow-[0_8px_24px_-6px_rgba(0,0,0,0.45)]
                     focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
        >
          {/* refresh / arrow-path glyph */}
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="flex-shrink-0"
          >
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
            <path d="M21 3v6h-6" />
          </svg>
          <span className="whitespace-nowrap">Update ready — tap to refresh</span>
        </Pressable>
      </m.div>
    </div>
  );
}
