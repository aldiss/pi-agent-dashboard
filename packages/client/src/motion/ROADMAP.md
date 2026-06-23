# Motion system — roadmap (follow-on launches)

Status: **foundation + Wave 1 shipped** on `feat/deep-slickness-motion`. This file
lists what is deliberately OUT of scope for that build — the next launches, each
independently shippable. Taste call holds throughout: **gentle + smooth, NO bounce**.

## Shipped (this build)
- `springs.ts` — the one vocabulary: `smooth` (400/42), `gentle` (240/30), `snappy` (520/34). No `bouncy`.
- `haptic.ts` — Capacitor-aware → `navigator.vibrate` → silent no-op.
- `reduced-motion.ts` — single `useMotionTransition()` gate; every spring collapses to instant under `prefers-reduced-motion`.
- `Pressable.tsx` — universal press primitive (whileTap scale + spring-back + optional selection haptic, polymorphic, ref-forwarding, disabled-aware).
- `Sheet.tsx` — gentle spring-enter, velocity drag-to-dismiss, real grab handle, scrim-dims-with-drag, focus trap, safe-area.
- Wave 1 application: composer send choreography (optimistic lift + success haptic, no spinner), model sheet → `<Sheet>`, nav swipe-back (velocity + rubber-band + gentle spring + commit haptic), `<Pressable>` across composer / session cards / sheet rows / nav controls.

---

## Wave 2 — flow & continuity (NEXT)
1. **Streaming reveal polish + smart scroll-to-bottom pill.** Build on the existing
   `ChatView.streaming-text-flush` path: smooth token reveal, intelligent
   auto-scroll, a scroll-to-bottom pill that appears only when the user has
   scrolled away from the tail. (Spec §3 "Streaming + optimistic polish".)
2. **Shared-element transitions (`layoutId`).** The single biggest "feels like an
   app" lever, deferred because it needs `domMax` (layout animations) — a heavier
   feature bundle. Two targets:
   - model-row → sheet (the row *becomes* the sheet header),
   - list card → detail header (the card *becomes* the detail).
   Measure the `domMax` bundle delta before adopting; gate behind the same
   LazyMotion so it stays lazy.

## Wave 3 — the detail pass
3. **List swipe-actions** (de-hover the touch-hostile affordances — hide/archive
   on swipe). Needs careful gesture-vs-scroll arbitration (reuse the swipe-back
   velocity/decide logic).
4. **Empty / loading / error states with character** — skeletons that match final
   layout; spinners only as last resort.
5. **Focus-visible rings + keyboard-rise choreography refinement.**

---

## Cross-cutting follow-ons (noted, not scheduled)
- **Legacy motion-freeze flag.** Motion is behavior, not visual identity, so it
  currently applies in BOTH skins (Legacy keeps byte-identical visuals, gains the
  better feel). If the operator later wants Legacy frozen to its old instant feel,
  that's a ONE-flag gate at the `useMotionTransition()` / `Pressable` / `Sheet`
  level (read skin, collapse to instant like reduced-motion). Do NOT fork motion
  per-skin — one gate, one flag.
- **Phase B Capacitor wrap.** `haptic()` is already Capacitor-aware; wrapping the
  client in Capacitor lights up real iOS haptics with zero change here. (Spec §5.)
- **Foundation unit tests.** springs/haptic/Pressable/Sheet currently proven by the
  Pattern-87 feel-gallery (drives real interactions, asserts effects) + e2e
  interaction assertions. Add focused jsdom unit tests for `haptic()` strategy
  selection + `Pressable` disabled-gating when convenient.
- **`domMax` adoption gate.** Wave 2 shared-element needs it; keep drag hand-rolled
  (as the Sheet + swipe-back already are) until a feature genuinely needs `domMax`,
  so the cold-load bundle stays lean.
