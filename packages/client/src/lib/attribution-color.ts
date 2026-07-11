/**
 * Per-operator attribution color (multi-operator, Surface A).
 *
 * Two schemes live here:
 *
 *  1. ROLE-ANCHORED (Option B, the 2-operator path) — `bubbleTintFor(author)`
 *     keys off the server-derived DISPLAY-ONLY `author.isOperator` bit. Operator
 *     → AMBER, guest → VIOLET. Guaranteed distinct for the N=2 case (op vs guest),
 *     so it can NEVER collide the way a hash can. This is the source of the
 *     Level-3 full-bubble tint.
 *
 *  2. HASH-STABLE FALLBACK — `attributionColorFor(sub)` maps an identity key to a
 *     curated palette accent by hashing `sub`. Retained for any author that lacks
 *     `isOperator` (older payloads / N>2 co-drivers) so they stay visually
 *     separated without a server-assigned index. Can collide for two subs that
 *     hash to the same slot — which is exactly why the 2-operator path is
 *     role-anchored instead.
 *
 * Pure + framework-free so both are unit-testable without a DOM.
 */
import type { MessageAuthor } from "@blackbelt-technology/pi-dashboard-shared/types.js";

/** One palette slot: dot fill + pill text/background/border, dashboard-themed. */
export interface AttributionColor {
  /** Tailwind class for the identity dot fill. */
  dot: string;
  /** Tailwind classes for the pill (text + tinted bg + border). */
  pill: string;
}

/**
 * Level-3 full-bubble tint tokens (raw CSS color strings for inline `style`,
 * NOT Tailwind classes — the tint is applied to the user bubble's
 * backgroundColor/borderColor/color directly). Role-anchored: operator = amber,
 * guest = violet.
 */
export interface AttributionTint {
  /** Bubble background fill (rgba, low alpha). */
  bg: string;
  /** Bubble border color (rgba, mid alpha). */
  border: string;
  /** Bubble text color (near-white, role-warm/cool). */
  text: string;
}

/** Operator (host) tint — AMBER. */
const OPERATOR_TINT: AttributionTint = {
  bg: "rgba(245,158,11,0.20)",
  border: "rgba(245,158,11,0.40)",
  text: "#f5efe6",
};

/** Guest tint — VIOLET. */
const GUEST_TINT: AttributionTint = {
  bg: "rgba(139,92,246,0.20)",
  border: "rgba(139,92,246,0.40)",
  text: "#eef0f6",
};

/**
 * Role-anchored bubble tint. `author.isOperator === true` → AMBER; anything else
 * (explicit guest `false`, or absent) → VIOLET. The two are DISTINCT by
 * construction, so the collision the hash could produce for two operators is
 * gone. DISPLAY-ONLY: `isOperator` never feeds any enforcement path.
 */
export function bubbleTintFor(author: MessageAuthor): AttributionTint {
  return author.isOperator === true ? OPERATOR_TINT : GUEST_TINT;
}

/**
 * Curated accents (avoid blue — the user bubble already owns blue, so the
 * attribution must not blend into it). Ordered; selection is hash-stable.
 */
const PALETTE: AttributionColor[] = [
  { dot: "bg-amber-400", pill: "text-amber-300 bg-amber-500/15 border-amber-500/30" },
  { dot: "bg-violet-400", pill: "text-violet-300 bg-violet-500/15 border-violet-500/30" },
  { dot: "bg-emerald-400", pill: "text-emerald-300 bg-emerald-500/15 border-emerald-500/30" },
  { dot: "bg-rose-400", pill: "text-rose-300 bg-rose-500/15 border-rose-500/30" },
  { dot: "bg-cyan-400", pill: "text-cyan-300 bg-cyan-500/15 border-cyan-500/30" },
  { dot: "bg-orange-400", pill: "text-orange-300 bg-orange-500/15 border-orange-500/30" },
];

/** Stable non-negative 32-bit hash of a string (djb2). */
function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

/** Map an operator `sub` to a stable palette accent. */
export function attributionColorFor(sub: string): AttributionColor {
  const idx = hashString(sub) % PALETTE.length;
  return PALETTE[idx];
}
