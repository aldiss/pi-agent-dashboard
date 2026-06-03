/**
 * Small reusable pin-toggle icon button. Sister-shape to the existing
 * MessageBubble action-bar pattern (copy / fork buttons): ~12px icon,
 * opacity-50 default → opacity-100 on hover, transition for graceful
 * appear/disappear.
 *
 * Cell: pi-agent-dashboard-ux-message-discoverability/v1 (W4.3 Feature 3).
 */

import React from "react";
import { Icon } from "@mdi/react";
import { mdiPin, mdiPinOutline } from "@mdi/js";

interface Props {
  entryId: string;
  isPinned: boolean;
  onToggle: (entryId: string) => void;
  /** Optional extra classes for parent layout overrides. */
  className?: string;
  /** Icon size in MDI units (default 0.6 — matches existing copy/fork
   *  buttons in MessageBubble's footer action bar). */
  size?: number;
  /** Whether to dim the button when not-pinned. Defaults to true so the
   *  action bar isn't visually noisy. When the parent wants the pin to
   *  be always-visible (e.g. tool-call header where the row is already
   *  compact), pass `false`. */
  dimWhenNotPinned?: boolean;
}

export function PinToggleButton({
  entryId,
  isPinned,
  onToggle,
  className = "",
  size = 0.6,
  dimWhenNotPinned = true,
}: Props) {
  // When pinned, render the filled pin icon at full opacity in a tinted
  // amber color so the operator can scan a long session and see the
  // pinned indicators at a glance. When not pinned, render the outlined
  // pin icon dimmed; hover lights it up so the click affordance is clear.
  const colorClass = isPinned
    ? "text-amber-400 hover:text-amber-300"
    : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]";
  const opacityClass = isPinned
    ? "opacity-100"
    : dimWhenNotPinned
      ? "opacity-50 hover:opacity-100"
      : "opacity-100";

  return (
    <button
      type="button"
      onClick={(e) => {
        // Tool-call header is a button itself (the expand/collapse row);
        // stop propagation so a pin-click doesn't also collapse the tool.
        e.stopPropagation();
        onToggle(entryId);
      }}
      title={isPinned ? "Unpin message" : "Pin message"}
      aria-label={isPinned ? "Unpin message" : "Pin message"}
      aria-pressed={isPinned}
      data-testid="pin-toggle-button"
      data-pinned={isPinned ? "true" : "false"}
      className={`p-0.5 rounded transition-opacity ${opacityClass} ${colorClass} ${className}`.trim()}
    >
      <Icon path={isPinned ? mdiPin : mdiPinOutline} size={size} />
    </button>
  );
}
