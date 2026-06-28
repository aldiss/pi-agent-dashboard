import React from "react";
import { Icon } from "@mdi/react";
import { mdiRobotOutline, mdiCursorDefaultClickOutline, mdiClockOutline, mdiForumOutline } from "@mdi/js";
import type { DriverNextEngagement, EngagementEffort } from "@blackbelt-technology/pi-dashboard-shared/types.js";

interface EffortStyle {
  label: string;
  icon: string;
  /** Tailwind classes: cool→warm hue encodes light→heavy operator effort. */
  cls: string;
}

const EFFORT_STYLES: Record<EngagementEffort, EffortStyle> = {
  "autonomous":     { label: "Autonomous", icon: mdiRobotOutline,              cls: "text-slate-400 bg-slate-500/10 border-slate-500/20" },
  "one-action":     { label: "1 action",   icon: mdiCursorDefaultClickOutline, cls: "text-blue-400 bg-blue-500/10 border-blue-500/20" },
  "short":          { label: "~5 min",      icon: mdiClockOutline,             cls: "text-amber-400 bg-amber-500/10 border-amber-500/20" },
  "back-and-forth": { label: "~30 min",     icon: mdiForumOutline,             cls: "text-orange-400 bg-orange-500/10 border-orange-500/20" },
};

/**
 * Per-driver next-engagement badge (dl-2620) — how much operator effort the
 * NEXT step needs. The async-mode signal: a driver works alone for a while,
 * then needs the operator — this badge shows the SHAPE of that need before the
 * operator opens the session. Cool→warm hue encodes light→heavy effort
 * (slate autonomous → blue 1-action → amber ~5min → orange ~30min back-and-
 * forth). Renders nothing when there is no next-engagement.
 */
export function EngagementBadge({ nextEngagement }: { nextEngagement: DriverNextEngagement | null | undefined }) {
  if (!nextEngagement) return null;
  const style = EFFORT_STYLES[nextEngagement.effort];
  if (!style) return null;
  const tooltip = `Next engagement: ${style.label}${nextEngagement.note ? ` — ${nextEngagement.note}` : ""}`;

  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[10px] font-medium shrink-0 ${style.cls}`}
      data-testid="engagement-badge"
      data-effort={nextEngagement.effort}
      title={tooltip}
    >
      <Icon path={style.icon} size={0.5} />
      <span>{style.label}</span>
    </span>
  );
}
