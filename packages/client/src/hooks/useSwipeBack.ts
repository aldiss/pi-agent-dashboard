import { useRef, useEffect } from "react";
import { useMotionValue, useTransform, animate, type MotionValue } from "motion/react";
import { springOptions } from "../motion/springs.js";
import { haptic } from "../motion/haptic.js";

interface SwipeBackOptions {
  /** Enable/disable the gesture (listeners only attach when true). */
  enabled: boolean;
  /** Resting target: true = detail shown (x→0), false = hidden (x→width). */
  shown: boolean;
  /** Called when swipe commits (also fired by a fast flick, not just distance). */
  onBack: () => void;
  /** Left-edge activation zone in px (default 40). */
  edgeZone?: number;
  /** Threshold fraction of screen width to trigger by distance (default 0.4). */
  threshold?: number;
  /** Fling velocity (px/s) that commits regardless of distance (default 500). */
  velocityThreshold?: number;
}

/**
 * iOS-style left-edge swipe-back — upgraded to spring physics.
 *
 * What changed vs the old CSS version:
 *   • VELOCITY — a fast flick commits even if short of the distance threshold,
 *     so a confident flick always goes back (the old code ignored velocity).
 *   • RUBBER-BAND — past the commit distance the panel tapers instead of
 *     tracking 1:1, so an over-drag feels physical, not loose.
 *   • SPRING COMPLETION — release (commit AND cancel) and forward-nav settle on
 *     the GENTLE spring, replacing the 300ms linear snap. One spring drives the
 *     whole slide, so it's interruptible and never reads mechanical.
 *   • HAPTIC — a selection tick fires the instant a back commits.
 *   • Parallax preserved — the list still trails at −30%, now derived from the
 *     same motion value so it stays in lockstep through the spring.
 *
 * Returns motion values the shell binds directly:
 *   detailX — detail panel translateX in px (0 shown … width hidden)
 *   listX   — list panel translateX as a % string (−30% … 0%) for the parallax
 */
export function useSwipeBack({
  enabled,
  shown,
  onBack,
  edgeZone = 40,
  threshold = 0.4,
  velocityThreshold = 500,
}: SwipeBackOptions): {
  containerRef: React.RefObject<HTMLDivElement | null>;
  detailX: MotionValue<number>;
  listX: MotionValue<string>;
} {
  const containerRef = useRef<HTMLDivElement>(null);
  const widthRef = useRef(typeof window !== "undefined" ? window.innerWidth : 0);

  const detailX = useMotionValue(shown ? 0 : widthRef.current);
  // Parallax: −30% when detail is fully shown (x=0), easing to 0% as it slides
  // off. Recomputed each frame against the live width so a rotate/resize can't
  // stale the range.
  const listX = useTransform(detailX, (v) => {
    const w = widthRef.current || 1;
    return `${-30 + Math.min(1, Math.max(0, v / w)) * 30}%`;
  });

  // Gesture tracking (refs — no re-render during the move).
  const dragging = useRef(false);
  const decided = useRef(false);
  const isHorizontal = useRef(false);
  const startX = useRef(0);
  const startY = useRef(0);
  const rawOffset = useRef(0); // unresisted finger distance, for the commit decision
  const lastX = useRef(0);
  const lastT = useRef(0);
  const velocity = useRef(0);

  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;

  // Resting-state spring: whenever `shown` flips and no drag is in flight, settle
  // the panel to its target on the gentle spring. This covers forward-nav
  // (width→0) AND back-completion after a committed swipe (0→width).
  useEffect(() => {
    if (dragging.current) return;
    const target = shown ? 0 : widthRef.current;
    const controls = animate(detailX, target, springOptions.gentle);
    return () => controls.stop();
  }, [shown, detailX]);

  useEffect(() => {
    function onResize() {
      widthRef.current = window.innerWidth;
      if (!dragging.current && !shown) detailX.set(widthRef.current);
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [shown, detailX]);

  useEffect(() => {
    if (!enabled) return;

    function handleTouchStart(e: TouchEvent) {
      const touch = e.touches[0];
      if (!touch || touch.clientX > edgeZone) return;
      dragging.current = true;
      decided.current = false;
      isHorizontal.current = false;
      startX.current = touch.clientX;
      startY.current = touch.clientY;
      rawOffset.current = 0;
      lastX.current = touch.clientX;
      lastT.current = e.timeStamp;
      velocity.current = 0;
      detailX.stop();
    }

    function handleTouchMove(e: TouchEvent) {
      if (!dragging.current) return;
      const touch = e.touches[0];
      if (!touch) return;

      const dx = touch.clientX - startX.current;
      const dy = touch.clientY - startY.current;

      if (!decided.current) {
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 10) return;
        decided.current = true;
        isHorizontal.current = Math.abs(dx) > Math.abs(dy);
      }
      if (!isHorizontal.current) {
        dragging.current = false;
        return;
      }

      // Prevent vertical scroll while swiping.
      e.preventDefault();

      const raw = Math.max(0, dx);
      rawOffset.current = raw;

      // Track velocity (px/s) from the latest frame delta.
      const dt = e.timeStamp - lastT.current;
      if (dt > 0) velocity.current = ((touch.clientX - lastX.current) / dt) * 1000;
      lastX.current = touch.clientX;
      lastT.current = e.timeStamp;

      // Rubber-band: 1:1 until the commit distance, then taper so an over-drag
      // resists instead of sliding loosely to the edge.
      const w = widthRef.current || 1;
      const tDist = w * threshold;
      const display = raw <= tDist ? raw : tDist + (raw - tDist) * 0.55;
      detailX.set(display);
    }

    function handleTouchEnd() {
      if (!dragging.current || !isHorizontal.current) {
        dragging.current = false;
        return;
      }
      dragging.current = false;

      const w = widthRef.current || 1;
      const committed = velocity.current > velocityThreshold || rawOffset.current > w * threshold;

      if (committed) {
        // Tactile tick at the moment of commit, then let the resting-state
        // spring (driven by the parent's depth→0) slide the panel out.
        haptic("selection");
        onBackRef.current();
      } else {
        // Weak flick → spring back to fully-shown, carrying release velocity.
        animate(detailX, 0, { ...springOptions.smooth, velocity: velocity.current });
      }
    }

    document.addEventListener("touchstart", handleTouchStart, { passive: true });
    document.addEventListener("touchmove", handleTouchMove, { passive: false });
    document.addEventListener("touchend", handleTouchEnd, { passive: true });
    document.addEventListener("touchcancel", handleTouchEnd, { passive: true });

    return () => {
      document.removeEventListener("touchstart", handleTouchStart);
      document.removeEventListener("touchmove", handleTouchMove);
      document.removeEventListener("touchend", handleTouchEnd);
      document.removeEventListener("touchcancel", handleTouchEnd);
    };
  }, [enabled, edgeZone, threshold, velocityThreshold, detailX]);

  return { containerRef, detailX, listX };
}
