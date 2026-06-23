/**
 * Motion system — the deep-slickness interaction layer.
 *
 * One spring vocabulary (gentle + smooth, NO bounce), a universal press
 * primitive, Capacitor-aware haptics, a throwable bottom sheet, and a single
 * reduced-motion gate. Built once here; applied across the app.
 *
 * Tree-shake discipline: the app is wrapped in <LazyMotion features={domAnimation}>
 * (see main.tsx) and every animated element uses the `m.*` namespace, so the
 * heavy motion feature set is never pulled into the eager bundle.
 */
export { spring, springOptions, type SpringName } from "./springs.js";
export { haptic, type HapticKind } from "./haptic.js";
export { useMotionTransition, type MotionGate } from "./reduced-motion.js";
export { Pressable, type PressableProps } from "./Pressable.js";
export { Sheet } from "./Sheet.js";
