/**
 * Per-operator attribution color (multi-operator, Surface A).
 *
 * Deterministically maps an operator identity key (`author.sub`) to a stable
 * accent from a curated palette that harmonizes with the dashboard's editorial
 * theme. Stable = the same operator always gets the same color across turns and
 * reloads (hash of `sub`, not call order), so op-1 vs op-2 stay visually
 * distinct without a server-assigned index.
 *
 * Pure + framework-free so it is unit-testable without a DOM.
 */

/** One palette slot: dot fill + pill text/background/border, dashboard-themed. */
export interface AttributionColor {
  /** Tailwind class for the identity dot fill. */
  dot: string;
  /** Tailwind classes for the pill (text + tinted bg + border). */
  pill: string;
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
