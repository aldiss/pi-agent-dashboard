import type { MessageAuthor } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import { attributionColorFor } from "../lib/attribution-color.js";

/**
 * Per-turn operator attribution chip (multi-operator, Surface A).
 *
 * Renders a compact pill — a stable per-operator color dot + the operator's
 * display name — above a committed user turn so co-driving operators can tell
 * op-1 from op-2 at a glance. The color is derived deterministically from
 * `author.sub`, so each operator keeps the same accent across turns.
 *
 * FLAG-OFF byte-unchanged: this component is rendered ONLY when a turn actually
 * carries an `author` (single-operator mode derives none → callers gate on
 * presence → nothing renders → the chat is identical to today).
 */
export function AttributionChip({ author }: { author: MessageAuthor }) {
  const color = attributionColorFor(author.sub);
  return (
    <div
      className={`inline-flex items-center gap-1.5 mb-1 px-2 py-0.5 rounded-full border text-[11px] font-medium leading-none ${color.pill}`}
      title={author.sub}
      data-attribution-sub={author.sub}
    >
      <span className={`inline-block w-1.5 h-1.5 rounded-full ${color.dot}`} aria-hidden="true" />
      <span className="truncate max-w-[12rem]">{author.display}</span>
    </div>
  );
}
