import type { Transition } from "motion/react";

/**
 * The ONE spring vocabulary — used everywhere. No more per-component magic
 * numbers. These are the exact configs the operator felt and approved in the
 * deep-slickness prototype: GENTLE + SMOOTH, NO BOUNCE.
 *
 * Taste call (the defining constraint): refined, settled motion that reads
 * editorial, not playful. Default to `smooth`. Use `gentle` for larger/softer
 * movement. `snappy` only for tiny press-backs where extra quickness helps.
 * There is deliberately NO `bouncy` token — the operator explicitly did not
 * want under-damped overshoot anywhere.
 *
 *   smooth  ζ ≈ 1.05  — critically-to-slightly-overdamped, no overshoot
 *   gentle  ζ ≈ 0.97  — effectively critically damped, ~no overshoot
 *   snappy  ζ ≈ 0.75  — quick settle for micro press-backs (still no visible bounce)
 *
 * (ζ = damping / (2·√(stiffness·mass)); mass defaults to 1.)
 */
export const spring = {
  /** PRIMARY workhorse — press-back, sheet settle, most transitions. */
  smooth: { type: "spring", stiffness: 400, damping: 42 },
  /** Large/soft moves — sheet enter, shared-element, page slide. */
  gentle: { type: "spring", stiffness: 240, damping: 30 },
  /** RARE — micro press-back only where extra quickness is needed. */
  snappy: { type: "spring", stiffness: 520, damping: 34 },
} as const satisfies Record<string, Transition>;

export type SpringName = keyof typeof spring;

/**
 * Imperative-animate spring options (the `animate(value, to, opts)` API used by
 * the hand-rolled Sheet drag). Same physical constants as the declarative
 * tokens above, expressed as the flat shape the imperative API expects.
 */
export const springOptions: Record<SpringName, { type: "spring"; stiffness: number; damping: number }> = {
  smooth: { type: "spring", stiffness: 400, damping: 42 },
  gentle: { type: "spring", stiffness: 240, damping: 30 },
  snappy: { type: "spring", stiffness: 520, damping: 34 },
};
