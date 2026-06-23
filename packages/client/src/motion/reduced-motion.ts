import { useReducedMotion } from "motion/react";
import { spring, springOptions, type SpringName } from "./springs.js";

/**
 * The single reduced-motion gate for the whole motion system.
 *
 * Discipline (non-negotiable, per the build brief): every spring collapses to
 * instant / near-instant under `prefers-reduced-motion: reduce`. The codebase
 * already honors the preference for CSS pulses; this extends the same discipline
 * to the JS motion layer so there is ONE place that decides "animate or not."
 *
 * `instant` is a zero-duration tween, not a spring — under reduced-motion the
 * element still arrives at its destination (state is correct), it just doesn't
 * travel. Press-scale, sheet enter/settle, send-lift, and nav-completion all
 * route their transition through `useMotionTransition()` so a single user
 * preference flips the entire system to non-animated.
 */
const INSTANT = { duration: 0 } as const;

export interface MotionGate {
  /** True when the user asked for reduced motion. */
  reduced: boolean;
  /** A declarative transition for the named spring, or instant when reduced. */
  transition: (name?: SpringName) => typeof spring[SpringName] | typeof INSTANT;
  /** Imperative-animate options for the named spring, or instant when reduced. */
  options: (name?: SpringName) => (typeof springOptions)[SpringName] | typeof INSTANT;
}

/**
 * Hook: returns the reduced-motion-aware transition resolvers. Defaults to the
 * `smooth` workhorse spring when no name is given.
 */
export function useMotionTransition(): MotionGate {
  const reduced = useReducedMotion() ?? false;
  return {
    reduced,
    transition: (name: SpringName = "smooth") => (reduced ? INSTANT : spring[name]),
    options: (name: SpringName = "smooth") => (reduced ? INSTANT : springOptions[name]),
  };
}
