import { useEffect, useRef, useState } from "react";

interface UsePullToRefreshOptions {
  /** Ref to the scrollable container the gesture is bound to. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Called when user pulls past threshold + releases. May return a promise; phase stays "refreshing" until it resolves. */
  onRefresh: () => Promise<void> | void;
  /** Pull distance in px (post-dampening) to trigger refresh. Default 70. */
  threshold?: number;
  /** Max pull distance (rubber-band cap; post-dampening). Default 120. */
  maxPull?: number;
  /** Multiplier on raw pull distance (rubber-band elastic feel). Default 0.5. */
  dampening?: number;
}

export type PullToRefreshPhase = "idle" | "pulling" | "refreshing";

export interface PullToRefreshState {
  phase: PullToRefreshPhase;
  /** Post-dampening pull distance in px (0 when idle). */
  pullDistance: number;
  /** True when phase=pulling AND pullDistance >= threshold (release here = refresh). */
  willTrigger: boolean;
}

/**
 * W10: iOS-native pull-to-refresh gesture on a scrollable container (RedHawk §2 item 11).
 *
 * Attaches passive touch listeners to the container ref. When the container is scrolled
 * to the top (scrollTop === 0) and the user pulls down, the hook tracks the pull distance
 * with rubber-band dampening (0.5x raw distance up to maxPull cap). On release past
 * threshold, fires onRefresh + transitions to "refreshing" phase until the promise resolves.
 * On release below threshold, snaps back to idle.
 *
 * Touch-only (`ontouchstart` feature-detect); no-op on desktop. Composes with native
 * scroll for vertical-scroll-up gestures (only intercepts pull-down at scroll-top).
 *
 * Consumer renders an indicator (e.g., chevron icon rotating with pullDistance, spinner
 * during refreshing) using the returned state. Container transform can be applied by
 * consumer via `style={{ transform: 'translateY(${pullDistance}px)' }}` for content-shift
 * elastic feel OR a fixed-position indicator can be shown without container shift.
 */
export function usePullToRefresh({
  containerRef,
  onRefresh,
  threshold = 70,
  maxPull = 120,
  dampening = 0.5,
}: UsePullToRefreshOptions): PullToRefreshState {
  const [state, setState] = useState<PullToRefreshState>({
    phase: "idle",
    pullDistance: 0,
    willTrigger: false,
  });
  const stateRef = useRef(state);
  stateRef.current = state;

  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (typeof window === "undefined" || !("ontouchstart" in window)) return; // touch-only

    let isTracking = false;
    let startY = 0;
    let decidedDirection = false;
    let isVertical = false;

    function onTouchStart(e: TouchEvent) {
      if (!container || container.scrollTop > 0) return;
      const touch = e.touches[0];
      if (!touch) return;
      startY = touch.clientY;
      isTracking = true;
      decidedDirection = false;
      isVertical = false;
    }

    function onTouchMove(e: TouchEvent) {
      if (!isTracking) return;
      const touch = e.touches[0];
      if (!touch) return;
      const dy = touch.clientY - startY;

      // Decide direction after small motion to avoid intercepting horizontal swipes
      if (!decidedDirection) {
        if (Math.abs(dy) < 10) return;
        isVertical = true; // we're tracking from scrollTop===0 origin; treat as vertical
        decidedDirection = true;
      }

      if (!isVertical) return;
      if (dy <= 0) {
        // Pulling up — abort gesture (user wants to scroll down inside list)
        if (stateRef.current.phase === "pulling") {
          setState({ phase: "idle", pullDistance: 0, willTrigger: false });
        }
        isTracking = false;
        return;
      }

      // Dampened pull (rubber-band elastic)
      const pullDistance = Math.min(dy * dampening, maxPull);
      const willTrigger = pullDistance >= threshold;
      e.preventDefault(); // prevent native overscroll-bounce competing
      setState({ phase: "pulling", pullDistance, willTrigger });
    }

    async function onTouchEnd() {
      if (!isTracking) return;
      isTracking = false;

      const current = stateRef.current;
      if (current.phase === "pulling" && current.willTrigger) {
        // Trigger refresh; stay in "refreshing" until onRefresh resolves
        setState({ phase: "refreshing", pullDistance: threshold, willTrigger: false });
        try {
          await onRefreshRef.current();
        } catch {
          // Swallow; consumer handles its own errors
        } finally {
          setState({ phase: "idle", pullDistance: 0, willTrigger: false });
        }
      } else {
        setState({ phase: "idle", pullDistance: 0, willTrigger: false });
      }
    }

    container.addEventListener("touchstart", onTouchStart, { passive: true });
    container.addEventListener("touchmove", onTouchMove, { passive: false });
    container.addEventListener("touchend", onTouchEnd, { passive: true });
    container.addEventListener("touchcancel", onTouchEnd, { passive: true });

    return () => {
      container.removeEventListener("touchstart", onTouchStart);
      container.removeEventListener("touchmove", onTouchMove);
      container.removeEventListener("touchend", onTouchEnd);
      container.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [containerRef, threshold, maxPull, dampening]);

  return state;
}
