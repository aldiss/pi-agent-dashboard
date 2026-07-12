/**
 * PendingInputBanner — cross-session operator-input surface.
 *
 * An always-visible strip at the app root that surfaces pending ask_user /
 * ctx.ui capsules raised in sessions the operator is NOT currently viewing, so
 * a high-stakes capsule (pi-bash-security / pi-skill-mandate / pi-cell-done-gate)
 * is never missed just because it fired in another session.
 *
 * READ-ONLY POINTER: the real prompt still resolves in its origin session
 * (no double-fire) — this only points + offers a jump. Fed by the server's
 * `pending_operator_inputs` broadcast; gated behind
 * config.crossSessionOperatorInput.enabled (off by default).
 *
 * Aesthetic: integrates with the dashboard design system (CSS variables + the
 * established Tier-A amber attention accent), refined restraint over novelty
 * so it reads as part of the app, not a foreign element.
 *
 * See NOS cell cross-session-askuser-surface.
 */
import React, { useEffect, useMemo, useState } from "react";
import { Icon } from "@mdi/react";
import { mdiAlertCircleOutline, mdiClockOutline, mdiChevronRight } from "@mdi/js";
import type { PendingOperatorInput } from "@blackbelt-technology/pi-dashboard-shared/browser-protocol.js";

const DISPLAY_CAP = 4;

function fmtDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 && m < 10 ? `${m}m ${rem}s` : `${m}m`;
}

/** Countdown to the server-enforced default-fire, or elapsed time when no finite timeout is enforced. */
function timeLabel(
  it: PendingOperatorInput,
  now: number,
): { label: string; urgent: boolean; firing: boolean } {
  if (it.deadlineAt === undefined) {
    return { label: `pending ${fmtDur(now - it.firstSeenAt)}`, urgent: false, firing: false };
  }
  const remaining = it.deadlineAt - now;
  if (remaining <= 0) return { label: "past deadline", urgent: true, firing: true };
  return { label: `blocks in ${fmtDur(remaining)}`, urgent: remaining <= 60_000, firing: false };
}

export function PendingInputBanner({
  items,
  selectedSessionId,
  onJump,
}: {
  items: PendingOperatorInput[];
  selectedSessionId?: string;
  onJump: (sessionId: string) => void;
}): React.ReactElement | null {
  const [now, setNow] = useState<number>(() => Date.now());

  // Suppress pointers for the session the operator is already viewing — they
  // see the real modal there.
  const visible = useMemo(
    () => items.filter((it) => it.sessionId !== selectedSessionId),
    [items, selectedSessionId],
  );

  // Tick once a second only while something is shown (drives the live countdown).
  useEffect(() => {
    if (visible.length === 0) return;
    const handle = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(handle);
  }, [visible.length]);

  if (visible.length === 0) return null;

  const shown = visible.slice(0, DISPLAY_CAP);
  const overflow = visible.length - shown.length;

  return (
    <div
      className="flex-shrink-0 border-b border-amber-500/30 bg-amber-500/10"
      data-testid="pending-input-banner"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-2 px-3 py-1.5">
        <Icon path={mdiAlertCircleOutline} size={0.62} className="text-amber-400 flex-shrink-0" />
        <span className="text-[11px] font-semibold uppercase tracking-wide text-amber-300 flex-shrink-0">
          Needs your input
          <span className="ml-1 font-normal text-amber-400/70">({visible.length})</span>
        </span>
        <ul className="flex items-center gap-1.5 overflow-x-auto list-none p-0 m-0 flex-1">
          {shown.map((it) => {
            const { label, urgent, firing } = timeLabel(it, now);
            return (
              <li key={`${it.sessionId}:${it.promptId}`} className="flex-shrink-0">
                <button
                  type="button"
                  onClick={() => onJump(it.sessionId)}
                  className="group flex items-center gap-1.5 rounded border border-amber-500/30 bg-[var(--bg-surface)] px-2 py-1 text-left transition-colors hover:border-amber-400/60 hover:bg-amber-500/10"
                  title={`${it.sessionName}: ${it.questionPreview}${it.defaultLabel ? ` — default: ${it.defaultLabel}` : ""} — click to jump to the session`}
                  aria-label={`${it.sessionName} needs input (${label}); jump to session`}
                >
                  <span className="max-w-[10rem] truncate text-[11px] font-medium text-[var(--text-primary)]">
                    {it.sessionName}
                  </span>
                  <span
                    className={`inline-flex items-center gap-0.5 text-[10px] font-semibold tabular-nums ${
                      urgent ? "text-red-400" : "text-amber-300"
                    } ${firing ? "animate-pulse" : ""}`}
                  >
                    <Icon path={mdiClockOutline} size={0.46} />
                    {label}
                  </span>
                  <Icon
                    path={mdiChevronRight}
                    size={0.62}
                    className="flex-shrink-0 text-amber-400/60 group-hover:text-amber-300"
                  />
                </button>
              </li>
            );
          })}
          {overflow > 0 && (
            <li className="flex-shrink-0 px-1 text-[10px] text-amber-400/70">+{overflow} more</li>
          )}
        </ul>
      </div>
    </div>
  );
}
