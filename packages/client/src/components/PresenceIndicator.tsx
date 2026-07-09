import type { PresenceParticipant } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import { attributionColorFor } from "../lib/attribution-color.js";

/**
 * Presence-of-two indicator (multi-operator, Surface B).
 *
 * Renders the distinct participants co-driving a live session as a compact
 * cluster of identity dots + a count, so each operator can see at a glance that
 * they are NOT alone. Each human's dot reuses the SAME per-`sub` accent as their
 * turn-attribution chip (Surface A `attributionColorFor`), so "who is here"
 * visually rhymes with "who wrote that". Agent participants (future, via
 * `getAgentPresence`) render with a neutral accent + a distinct ring.
 *
 * FLAG-OFF / single-operator byte-unchanged: renders NOTHING unless there are
 * at least TWO participants. A solo operator (or no presence data) shows no
 * chrome — the header is identical to today.
 */
export function PresenceIndicator({ participants }: { participants: PresenceParticipant[] }) {
  // Presence-of-TWO: only surface when more than one participant is co-driving.
  if (!participants || participants.length < 2) return null;

  return (
    <div
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-[var(--bg-surface)] border border-[var(--border-color)]"
      title={`${participants.length} participants co-driving: ${participants.map((p) => p.display).join(", ")}`}
      data-presence-count={participants.length}
    >
      <div className="flex -space-x-1.5">
        {participants.map((p) => {
          const isAgent = p.kind === "agent";
          const color = attributionColorFor(p.id);
          const initial = (p.display?.[0] ?? "?").toUpperCase();
          return (
            <span
              key={`${p.kind}:${p.id}`}
              className={
                `inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-semibold ` +
                `ring-2 ring-[var(--bg-surface)] ${isAgent ? "bg-[var(--text-tertiary)] text-white" : `${color.dot} text-black/80`}`
              }
              title={`${p.display}${isAgent ? " (agent)" : ""}`}
              data-presence-id={p.id}
              data-presence-kind={p.kind}
            >
              {initial}
            </span>
          );
        })}
      </div>
      <span className="text-[11px] font-medium text-[var(--text-secondary)] leading-none pr-0.5">
        {participants.length}
      </span>
    </div>
  );
}
