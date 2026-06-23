import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type PointerEvent as ReactPointerEvent } from "react";
import { m, useMotionValue, useTransform, animate, useReducedMotion } from "motion/react";
import { DialogPortal } from "../components/DialogPortal.js";
import { springOptions } from "./springs.js";
import { haptic } from "./haptic.js";

/**
 * <Sheet> — the bottom-sheet primitive. Replaces the bare DialogPortal
 * instant-mount for sheets with a real, throwable surface:
 *
 *   • GENTLE spring-enter from the bottom (no bounce — the taste call).
 *   • DRAG-TO-DISMISS with velocity: throw it down and it goes; a weak flick
 *     springs back with the SMOOTH token. Drag starts from the grab handle /
 *     header only, so an internal scroll area still scrolls normally.
 *   • A REAL working grab handle (not decorative).
 *   • Scrim that DIMS WITH THE DRAG — opacity tracks sheet position, so pulling
 *     the sheet down fades the backdrop in lockstep (the detail that sells it).
 *   • Focus trap + Esc-to-close + focus restore.
 *   • Scrim tap-to-dismiss.
 *   • env(safe-area-inset-bottom) padding so content clears the home indicator.
 *
 * Lifecycle: the caller mounts the Sheet while it should be visible
 * (`{open && <Sheet onClose=… />}`). Gesture / scrim / Esc dismissals run the
 * exit animation HERE and call `onClose` only when it finishes, so the caller's
 * unmount lands after the sheet has slid away. Programmatic close (e.g. picking
 * a row) may call `onClose` directly for an immediate dismiss.
 *
 * Reduced-motion: enter is instant (no travel), dismissals call `onClose`
 * immediately. The haptic still fires — a tactile tick is an aid, not motion.
 */
interface SheetProps {
  /** Invoked once the sheet has finished dismissing (caller unmounts here). */
  onClose: () => void;
  children: ReactNode;
  /** Extra classes for the sheet panel (bg / border / shadow live in the caller). */
  className?: string;
  /** Classes for the scrollable content wrapper below the grab handle. */
  contentClassName?: string;
  ariaLabel?: string;
  "data-testid"?: string;
  scrimTestid?: string;
}

/** Dismiss if thrown faster than this (px/s) regardless of distance. */
const VELOCITY_DISMISS = 700;
/** Or dismiss if dragged past this fraction of the sheet's own height. */
const DISTANCE_DISMISS_FRAC = 0.4;

export function Sheet({
  onClose,
  children,
  className = "",
  contentClassName = "",
  ariaLabel,
  "data-testid": dataTestid,
  scrimTestid,
}: SheetProps) {
  const reduced = useReducedMotion() ?? false;
  const sheetRef = useRef<HTMLDivElement>(null);
  const y = useMotionValue(0);
  // Measured sheet height; seeded large so the scrim transform has a sane range
  // before first layout. Replaced with the real height in useLayoutEffect.
  const [sheetHeight, setSheetHeight] = useState(640);
  const scrimOpacity = useTransform(y, [0, sheetHeight], [1, 0], { clamp: true });
  const dismissingRef = useRef(false);

  // ── Enter: measure, seed offscreen, gently rise (or jump in when reduced). ──
  useLayoutEffect(() => {
    const el = sheetRef.current;
    if (!el) return;
    const h = el.offsetHeight || 640;
    setSheetHeight(h);
    if (reduced) {
      y.set(0);
      return;
    }
    y.set(h);
    const controls = animate(y, 0, springOptions.gentle);
    return () => controls.stop();
    // Run once on mount; y / reduced are stable for the sheet's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Animated dismiss: slide out, then hand control back to the caller. ──
  function dismiss() {
    if (dismissingRef.current) return;
    dismissingRef.current = true;
    if (reduced) {
      onClose();
      return;
    }
    const h = sheetRef.current?.offsetHeight || sheetHeight;
    animate(y, h, { ...springOptions.gentle, velocity: y.getVelocity() }).then(() => onClose());
  }

  // ── Focus trap + Esc + focus restore. ──
  useEffect(() => {
    const el = sheetRef.current;
    const prevFocus = document.activeElement as HTMLElement | null;
    el?.focus({ preventScroll: true });

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        dismiss();
        return;
      }
      if (e.key !== "Tab" || !el) return;
      const focusable = el.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      prevFocus?.focus?.({ preventScroll: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Hand-rolled vertical drag (handle/header only). ──
  const drag = useRef({ active: false, startY: 0, startSheetY: 0, lastY: 0, lastT: 0, vel: 0 });

  function onPointerDown(e: ReactPointerEvent) {
    if (dismissingRef.current) return;
    y.stop();
    drag.current = { active: true, startY: e.clientY, startSheetY: y.get(), lastY: e.clientY, lastT: e.timeStamp, vel: 0 };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }
  function onPointerMove(e: ReactPointerEvent) {
    const d = drag.current;
    if (!d.active) return;
    const next = Math.max(0, d.startSheetY + (e.clientY - d.startY)); // down-only
    const dt = e.timeStamp - d.lastT;
    if (dt > 0) d.vel = ((e.clientY - d.lastY) / dt) * 1000;
    d.lastY = e.clientY;
    d.lastT = e.timeStamp;
    y.set(next);
  }
  function onPointerUp() {
    const d = drag.current;
    if (!d.active) return;
    d.active = false;
    const past = y.get() > sheetHeight * DISTANCE_DISMISS_FRAC;
    if (d.vel > VELOCITY_DISMISS || past) {
      haptic("selection");
      dismiss();
    } else {
      animate(y, 0, { ...springOptions.smooth, velocity: d.vel });
    }
  }

  return (
    <DialogPortal>
      {/* Scrim — opacity tracks the sheet position (dims with the drag). */}
      <m.div
        className="fixed inset-0 z-[60] bg-[var(--bg-overlay)]"
        style={{ opacity: scrimOpacity }}
        onClick={dismiss}
        data-testid={scrimTestid}
        aria-hidden="true"
      />
      {/* Sheet panel. */}
      <m.div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        className={`fixed inset-x-0 bottom-0 z-[61] max-h-[88vh] flex flex-col rounded-t-3xl outline-none ${className}`}
        style={{ y, paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))", touchAction: "none" }}
        data-testid={dataTestid}
      >
        {/* Grab handle + header zone — the drag surface. */}
        <div
          className="shrink-0 pt-2.5 pb-1 flex justify-center cursor-grab active:cursor-grabbing"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          data-testid="sheet-grab-handle"
        >
          <span className="w-10 h-1.5 rounded-full bg-[var(--border-secondary)]" />
        </div>
        <div className={`flex-1 min-h-0 flex flex-col ${contentClassName}`} style={{ touchAction: "pan-y" }}>
          {children}
        </div>
      </m.div>
    </DialogPortal>
  );
}
