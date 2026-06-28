import React from "react";
import { Icon } from "@mdi/react";
import { mdiProgressCheck, mdiFlagCheckered } from "@mdi/js";
import type { DriverProgress } from "@blackbelt-technology/pi-dashboard-shared/types.js";

interface Props {
  /** The driver's self-reported progress, or null/undefined when none. */
  progress: DriverProgress | null | undefined;
  /** Compact inline mode for the session-card row (fixed-ish width). */
  compact?: boolean;
}

/**
 * Per-driver work-progress bar (dl-2620). Sibling to ContextUsageBar but
 * semantically INVERTED: progress-high = good (work done), so it fills an
 * emerald accent toward 100 — distinct from context's grey→yellow→red
 * "filling up = bad" ramp. Shown ALONGSIDE context-% so the operator can
 * triage drivers at a glance ("this one's almost done → focus there"). The
 * leading glyph flips to a checkered flag at 100% (done). Renders nothing when
 * there is no progress, so non-driver cards are unaffected.
 */
export function DriverProgressBar({ progress, compact }: Props) {
  if (!progress || typeof progress.pct !== "number") return null;
  const pct = Math.max(0, Math.min(100, Math.round(progress.pct)));
  const done = pct >= 100;

  return (
    <div
      className={compact ? "flex items-center gap-1 w-24" : "flex items-center gap-1.5"}
      data-testid="driver-progress-bar"
      title={buildTooltip(progress, pct)}
    >
      <Icon
        path={done ? mdiFlagCheckered : mdiProgressCheck}
        size={0.5}
        className={`shrink-0 ${done ? "text-emerald-400" : "text-emerald-500/70"}`}
      />
      <div className="h-1.5 flex-1 rounded-full bg-[var(--bg-surface)] overflow-hidden">
        <div
          className={`h-full rounded-full ${done ? "bg-emerald-400" : "bg-emerald-500/70"}`}
          style={{ width: `${pct}%` }}
          data-testid="driver-progress-fill"
        />
      </div>
      <span
        className="text-[10px] text-emerald-400/90 tabular-nums shrink-0"
        data-testid="driver-progress-pct"
      >
        {pct}%
      </span>
    </div>
  );
}

function buildTooltip(p: DriverProgress, pct: number): string {
  const parts: string[] = [];
  if (p.label) parts.push(p.label);
  if (typeof p.milestonesDone === "number" && typeof p.milestonesTotal === "number") {
    parts.push(`${p.milestonesDone}/${p.milestonesTotal} milestones`);
  }
  parts.push(`${pct}% done`);
  return parts.join(" · ");
}
