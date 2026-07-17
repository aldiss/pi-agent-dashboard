/**
 * FleetBriefBanner — the depth-0 fleet-brief (build-2 P0 fix #12).
 *
 * "What needs me", surfaced REGARDLESS of tier / pin / collapse. THIS is the
 * global escalation lane — there is no second one. Each row is a click-through
 * that selects the session (or opens the surface url). Acknowledgement of the
 * finished-unseen window fires ONLY when the banner is actually visible
 * (`isVisible` — never on mount; the mobile shell keeps the depth-0 panel
 * mounted-but-aria-hidden at depth ≥ 1).
 *
 * Styled with the existing dashboard Tailwind tokens (var(--*) + the amber/red
 * accent language already used by ActiveOperatorSurfaces) so it reads native.
 *
 * See change: build-2-dashboard-v3.
 */
import React, { useEffect } from "react";
import { Icon } from "@mdi/react";
import { mdiAlertCircleOutline, mdiCommentQuestion, mdiClipboardCheckOutline, mdiChevronRight } from "@mdi/js";
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import type { FleetBriefItem } from "../lib/fleet-brief.js";
import { getSessionDisplayName } from "../lib/session-display-name.js";

interface Props {
  items: FleetBriefItem[];
  finishedUnseen: DashboardSession[];
  /** True when the banner is actually on-screen (depth-0 on mobile, always on
   *  desktop). Gates acknowledgement — never acknowledge while hidden. */
  isVisible: boolean;
  onSelect: (sessionId: string) => void;
  /** Persist "seen now" — the hook advances the finished-unseen window. */
  acknowledge: () => void;
}

function reasonIcon(reason: FleetBriefItem["reason"]): string {
  if (reason === "server-error") return mdiAlertCircleOutline;
  if (reason === "ask-user") return mdiCommentQuestion;
  return mdiClipboardCheckOutline;
}

function reasonAccent(reason: FleetBriefItem["reason"]): string {
  if (reason === "server-error") return "text-red-400";
  if (reason === "ask-user") return "text-purple-400";
  return "text-amber-400";
}

function reasonLabel(reason: FleetBriefItem["reason"]): string {
  switch (reason) {
    case "server-error": return "error";
    case "ask-user": return "needs input";
    case "decide": return "decide";
    case "ratify": return "ratify";
    case "review": return "review";
    case "push": return "push";
    default: return reason;
  }
}

export function FleetBriefBanner({
  items,
  finishedUnseen,
  isVisible,
  onSelect,
  acknowledge,
}: Props): React.ReactElement | null {
  // Acknowledge on ACTUAL visibility only (fix #6). Fires when the banner
  // becomes visible (mount-while-visible, or a hidden→visible transition), and
  // whenever the unseen set changes while visible. NEVER on mount-while-hidden.
  useEffect(() => {
    if (isVisible) acknowledge();
  }, [isVisible, acknowledge, items.length, finishedUnseen.length]);

  const total = items.length + finishedUnseen.length;
  if (total === 0) return null;

  return (
    <div
      className="border-b border-[var(--border-color)] bg-[var(--bg-secondary)] flex-shrink-0"
      data-testid="fleet-brief-banner"
    >
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        <span className="text-xs font-semibold text-[var(--text-primary)] flex-1">
          Needs you
          <span className="text-[var(--text-secondary)] ml-1" data-testid="fleet-brief-count">
            ({total})
          </span>
        </span>
      </div>
      <ul className="list-none p-0 m-0">
        {items.map((item) => (
          <li key={`${item.kind}:${item.id}`}>
            <button
              onClick={() => {
                if (item.kind === "session") {
                  onSelect(item.id);
                } else if (item.surface?.url && /^https?:\/\//i.test(item.surface.url)) {
                  window.open(item.surface.url, "_blank", "noopener,noreferrer");
                }
              }}
              className="w-full flex items-center gap-2 px-2 py-1.5 text-left border-b border-[var(--border-color)] last:border-b-0 hover:bg-[var(--bg-surface)] transition-colors"
              data-testid={`fleet-brief-item-${item.kind}`}
              data-reason={item.reason}
            >
              <Icon path={reasonIcon(item.reason)} size={0.6} className={`shrink-0 ${reasonAccent(item.reason)}`} />
              <span className="flex-1 min-w-0">
                <span className="block text-xs font-medium text-[var(--text-primary)] truncate">
                  {item.label}
                </span>
                <span className={`text-[10px] uppercase tracking-wider ${reasonAccent(item.reason)}`}>
                  {reasonLabel(item.reason)}
                </span>
              </span>
              <Icon path={mdiChevronRight} size={0.6} className="shrink-0 text-[var(--text-tertiary)]" />
            </button>
          </li>
        ))}
        {finishedUnseen.length > 0 && (
          <li className="px-2 py-1 border-b border-[var(--border-color)] last:border-b-0">
            <span className="text-[10px] text-[var(--text-tertiary)]">
              {finishedUnseen.length} recently finished
            </span>
            <div className="mt-0.5 flex flex-col gap-0.5">
              {finishedUnseen.map((s) => (
                <button
                  key={s.id}
                  onClick={() => onSelect(s.id)}
                  className="w-full text-left text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] truncate transition-colors"
                  data-testid="fleet-brief-finished-item"
                >
                  {getSessionDisplayName(s)}
                </button>
              ))}
            </div>
          </li>
        )}
      </ul>
    </div>
  );
}
