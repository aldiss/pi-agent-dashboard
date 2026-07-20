/**
 * ThreadStatusBadge — the per-thread CURRENT-STATUS pill (design v0.3 Tier-1
 * §"What Tier-1 IS" #2). Renders the ONE authoritative P1 `thread-status-read`
 * verdict: `building / in_flight / delivered / failed / corrupt`. It DISPLAYS
 * the verdict — it never infers status from history, never re-derives it.
 *
 * The `building` kind is the graceful-degrade "not yet wired" state (the core's
 * outbox substrate is mid-build, 0 worktree hits today) — rendered calm and
 * explicit, with the machine reason as a caption, never as a scary error.
 *
 * Theme-safe: CSS-var accent tokens only (the B5 `ThreadView` discipline) — no
 * hardcoded hex, so every theme (dark / light / warm-stone) renders correctly.
 */
import React from "react";
import { Icon } from "@mdi/react";
import {
  mdiCheckDecagram,
  mdiAlertOctagon,
  mdiProgressClock,
  mdiHammerWrench,
  mdiHelpRhombus,
} from "@mdi/js";
import {
  STATUS_META,
  REASON_CAPTION,
  type ThreadStatus,
  type ThreadStatusKind,
} from "../lib/tier1-threads-api.js";

const KIND_ICON: Record<ThreadStatusKind, string> = {
  building: mdiHammerWrench,
  in_flight: mdiProgressClock,
  delivered: mdiCheckDecagram,
  failed: mdiAlertOctagon,
  corrupt: mdiHelpRhombus,
};

interface Props {
  status: ThreadStatus;
  /** Compact pill (list rows) vs. full pill+caption (detail header). */
  variant?: "compact" | "full";
}

export function ThreadStatusBadge({ status, variant = "compact" }: Props) {
  const meta = STATUS_META[status.kind];
  const icon = KIND_ICON[status.kind];
  const caption = status.reason ? REASON_CAPTION[status.reason] : meta.meaning;

  return (
    <div className="flex flex-col gap-1" data-testid="thread-status-badge" data-status-kind={status.kind}>
      <span
        className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full self-start"
        style={{
          color: meta.accent,
          backgroundColor: "color-mix(in srgb, currentColor 14%, transparent)",
        }}
      >
        <Icon path={icon} size={0.55} />
        {meta.label}
        {typeof status.revision === "number" && (
          <span className="opacity-70" style={{ fontFamily: "var(--font-mono)" }}>
            rev {status.revision}
          </span>
        )}
      </span>
      {variant === "full" && (
        <p className="text-[11px] leading-snug" style={{ color: "var(--text-secondary)" }} data-testid="thread-status-caption">
          {caption}
        </p>
      )}
    </div>
  );
}
