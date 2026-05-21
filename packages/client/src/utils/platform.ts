/**
 * W12: `isCapacitorNative()` platform detection helper.
 *
 * In Phase 1 PWA-enhancement (Q1 ratified-defer; current cell scope), returns false
 * always — composer-shell selection in CommandInput.tsx falls through to `useMobile()`
 * touch-primary check. In Phase 2 (Capacitor commit; gated by W13 Web Push verification),
 * this returns `(window as any).Capacitor?.isNativePlatform?.() === true` so MobileComposer
 * also activates inside the native Capacitor shell.
 *
 * Placeholder per Q2 ratified-allow `isCapacitorNative()`-equivalent guard mention in
 * mobile cell W12 acceptance.
 */
export function isCapacitorNative(): boolean {
  if (typeof window === "undefined") return false;
  // Phase 1: always false; mobile composer activates via useMobile() touch-primary check only.
  // Phase 2 (Capacitor): uncomment the line below + remove the false return.
  // return Boolean((window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.());
  return false;
}

/**
 * W12 r16 BUGFIX (operator-direct architectural directive 2026-05-17 ~06 CEST):
 * device-class detect for mobile-vs-desktop composer rendering. Operator framing
 * (Russian, translated): "behavior should NOT be regulated by viewport-width;
 * it should be based on the device — iPhone = mobile behavior, MacBook = desktop".
 *
 * Replaces the earlier r15 `matchMedia("(pointer: coarse)")` capability-based fix which
 * was "close but not device-class" per operator. This is now the canonical "render
 * MobileComposer" detector.
 *
 * 3-layer device-class detection (most-reliable first):
 *   1. Modern Chromium-based UAData (Chrome 90+, Edge 90+, Opera 76+) — `navigator.userAgentData.mobile`
 *      Source-of-truth when available; Safari does NOT have UAData (per spec discussion)
 *   2. UA-string regex — covers Safari + older browsers (iPhone, iPad, iPod, Android, generic Mobile)
 *   3. iPadOS 13+ "Request Desktop Site" workaround — Mac UA + maxTouchPoints>1 means iPad-as-Mac
 *      (Apple's intentional UA-confusion for iPad on iPadOS 13+; touch-points reveals the truth)
 *
 * Edge cases:
 *   - iPad attached to keyboard+trackpad: still returns true (iPad is mobile-shell device)
 *   - MacBook with touchscreen via accessibility: returns false (no Mac touchscreens exist;
 *     accessibility touch-points usually =0)
 *   - SSR / non-window context: returns false (defensive)
 */
export function isMobileDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  // Layer 1: Modern Chromium-based UAData
  const uaData = (navigator as { userAgentData?: { mobile?: boolean } }).userAgentData;
  if (uaData && typeof uaData.mobile === "boolean") return uaData.mobile;
  // Layer 2: UA-string regex (Safari + older browsers)
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod|Android|Mobile/i.test(ua)) return true;
  // Layer 3: iPadOS 13+ "Request Desktop Site" — Mac UA but multi-touch capable
  if (/Mac/i.test(ua) && typeof navigator.maxTouchPoints === "number" && navigator.maxTouchPoints > 1) {
    return true;
  }
  return false;
}

/**
 * W12 r20 BUGFIX (operator-direct empirical 2026-05-17 ~CEST: iPad-with-Magic-Keyboard wants
 * desktop-Enter-to-send, not mobile-button-send). Operator framing verbatim per Pattern 87
 * (typos `hae` + `conudnrum` PRESERVED): "for choice between enter vs shift enter.. - i hae a
 * bit of a conudnrum - i have an ipad with magic keyboard - it is very unnerving to always
 * click 'send' button instead of enter here.."
 *
 * Engineering reframing: input-method-class > device-class for THIS composer-routing decision.
 * Composes `isMobileDevice()` (device-class detect) with `(any-pointer: fine)` media-query
 * (input-method-class detect). When device is mobile AND a fine-pointer device is attached
 * (Magic Keyboard trackpad, Bluetooth mouse, stylus with click), route to CommandInput desktop
 * path for Enter-to-send. Pure-touch mobile devices (iPhone alone, iPad alone) still route to
 * MobileComposer per r16 device-class detect.
 *
 * Truth table verification:
 *   iPhone alone: isMobileDevice=true, any-pointer:fine=false → MobileComposer ✓
 *   iPad alone: same → MobileComposer ✓
 *   iPad + Magic Keyboard with trackpad: any-pointer:fine=true → CommandInput desktop ✓ (operator case)
 *   MacBook: isMobileDevice=false → CommandInput desktop ✓
 *   Touchscreen Windows laptop: isMobileDevice=true + any-pointer:fine=true → CommandInput desktop ✓
 *
 * Edge case banked: iPhone + Bluetooth keyboard without trackpad (no fine pointer) still routes
 * to MobileComposer; acceptable per operator framing (rare; Phase 1.1 Settings-override candidate).
 */
export function shouldUseMobileComposer(): boolean {
  if (typeof window === "undefined") return false;
  if (!isMobileDevice()) return false;
  // Mobile device — but check if fine-pointer device attached (keyboard trackpad, mouse, stylus)
  if (window.matchMedia("(any-pointer: fine)").matches) return false;
  return true;
}
