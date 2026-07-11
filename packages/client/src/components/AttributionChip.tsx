import type { MessageAuthor } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import { attributionColorFor } from "../lib/attribution-color.js";

/**
 * Per-turn operator attribution chip (multi-operator, Surface A — Option B).
 *
 * Renders a compact pill above a committed user turn so co-driving operators can
 * tell op-1 from op-2 (and themselves from the other) at a glance. Two cues,
 * neither color-only:
 *
 *  - LABEL — `author.sub === viewerSub ? "You" : author.display`. The viewer sees
 *    their own turns as "You", every other operator by display name. Name-always
 *    / You-always (never color-only) so the distinction survives color-blindness.
 *  - DOT — ROLE-anchored, DISPLAY-ONLY `author.isOperator`: operator → FILLED
 *    amber; guest → RING violet (a shape cue, not just a hue). For an author that
 *    lacks `isOperator` (older payload / N>2 co-driver) the dot falls back to the
 *    hash-stable palette fill so those turns still separate visually.
 *
 * FLAG-OFF byte-unchanged: this component renders ONLY when a turn actually
 * carries an `author` (single-operator mode derives none → callers gate on
 * presence → nothing renders → the chat is identical to today).
 */
export function AttributionChip({ author, viewerSub }: { author: MessageAuthor; viewerSub?: string }) {
  const isSelf = viewerSub !== undefined && author.sub === viewerSub;
  const label = isSelf ? "You" : author.display;

  // Role-anchored dot. Operator → filled amber; explicit guest → violet ring.
  // Author lacking `isOperator` → hash-stable palette fill (N>2 fallback).
  const roleKnown = author.isOperator !== undefined;
  const isOperator = author.isOperator === true;
  const fallback = attributionColorFor(author.sub);

  const pillClass = !roleKnown
    ? fallback.pill
    : isOperator
      ? "text-amber-200 bg-amber-500/15 border-amber-500/40"
      : "text-violet-200 bg-violet-500/15 border-violet-500/40";

  const dotClass = !roleKnown
    ? `inline-block w-1.5 h-1.5 rounded-full ${fallback.dot}`
    : isOperator
      ? "inline-block w-1.5 h-1.5 rounded-full bg-amber-400"
      : "inline-block w-1.5 h-1.5 rounded-full border border-violet-300";

  return (
    <div
      className={`inline-flex items-center gap-1.5 mb-1 px-2 py-0.5 rounded-full border text-[11px] font-medium leading-none ${pillClass}`}
      title={author.sub}
      data-attribution-sub={author.sub}
      data-attribution-role={roleKnown ? (isOperator ? "operator" : "guest") : "unknown"}
      data-attribution-self={isSelf ? "true" : "false"}
    >
      <span className={dotClass} aria-hidden="true" />
      <span className="truncate max-w-[12rem]">{label}</span>
    </div>
  );
}
