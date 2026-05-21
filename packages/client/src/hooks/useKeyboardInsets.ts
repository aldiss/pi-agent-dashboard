import { useEffect, useState } from "react";

interface KeyboardInsets {
  /** CSS pixels of keyboard occlusion (0 when keyboard down). */
  keyboardHeight: number;
  /** Convenience: keyboardHeight > 50 (iOS-Safari empirical threshold per Termina1 3df2a0ec). */
  keyboardUp: boolean;
}

/**
 * Tracks iOS Safari soft-keyboard occlusion via window.visualViewport.
 *
 * Side effect: sets `--keyboard-h` CSS-var on document.documentElement so
 * bottom-panel CSS can consume via `var(--keyboard-h, 0px)` (e.g. MobileShell
 * panel paddingBottom shrinks panel area when keyboard rises so content stays
 * visible above the keyboard).
 *
 * Composes with Termina1's local visualViewport hook in CommandInput.tsx
 * (3df2a0ec) — CommandInput retains its local `keyboardUp` state for
 * paddingBottom toggle (safe-area-inset-bottom skip-when-keyboard-up logic
 * stays untouched). This shared hook adds the CSS-var infrastructure for
 * MobileShell panels + future mobile-bottom-panel components (W12
 * MobileComposer, MobileActionMenu, future bottom sheets) without
 * refactoring CommandInput.
 *
 * Pattern matches Termina1 3df2a0ec detection (occlusion = innerHeight - visualViewport.height).
 *
 * r28 BUGFIX (operator empirical 2026-05-18 ~18:48 CEST via YoungUnion peggy relay,
 * Pattern 87 PRESERVED: "see here - all this space in the bottom just lost"): on iOS
 * Safari, `window.innerHeight - visualViewport.height` includes BOTH the soft-keyboard
 * occlusion AND the address bar + bottom navigation toolbar height. When `--keyboard-h`
 * was set to the raw occlusion AND the container used `h-[100dvh]` (which already
 * dynamically accounts for browser chrome), the address-bar height was DOUBLE-subtracted
 * → ~30% empty white space at the bottom of mobile detail-panel viewport.
 *
 * Fix: threshold the CSS-var setter to only apply occlusion above the keyboardUp threshold
 * (>50px = clearly keyboard; ≤50px = address-bar chrome, leave CSS-var at 0 so `h-[100dvh]`
 * is the single source of viewport-fit). Composes cleanly with `keyboardUp = > 50` predicate
 * (same threshold used as `keyboardUp` flag for downstream consumers).
 */
export function useKeyboardInsets(): KeyboardInsets {
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    if (typeof window === "undefined" || !window.visualViewport) return;
    const onResize = () => {
      const vh = window.visualViewport!.height;
      const wh = window.innerHeight;
      const occlusion = Math.max(0, wh - vh);
      setKeyboardHeight(occlusion);
      // r28 BUGFIX: only set CSS var when occlusion is clearly keyboard-shaped (>50px).
      // ≤50px range is iOS Safari address-bar / bottom-toolbar chrome which is ALREADY
      // accounted for by `h-[100dvh]` on MobileShell container. Double-subtracting it via
      // paddingBottom: var(--keyboard-h) created ~30% empty white space at bottom of
      // mobile detail-panel (operator empirical 2026-05-18 via YoungUnion peggy relay).
      const cssValue = occlusion > 50 ? occlusion : 0;
      document.documentElement.style.setProperty("--keyboard-h", `${cssValue}px`);
    };
    window.visualViewport.addEventListener("resize", onResize);
    window.visualViewport.addEventListener("scroll", onResize);
    onResize();
    return () => {
      window.visualViewport?.removeEventListener("resize", onResize);
      window.visualViewport?.removeEventListener("scroll", onResize);
      document.documentElement.style.removeProperty("--keyboard-h");
    };
  }, []);

  return { keyboardHeight, keyboardUp: keyboardHeight > 50 };
}
