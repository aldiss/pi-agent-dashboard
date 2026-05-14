/**
 * MachineBadge — session-card badge that renders the peer's machineId
 * for federated sessions.
 *
 * The badge claim is predicated on `isFederatedSession`; the slot host
 * in dashboard-plugin-runtime's slot-consumers.tsx invokes the predicate
 * before rendering, so we can rely on session being a federated row here.
 */

import React from "react";
import { machineIdOf, type DashboardSessionLike } from "./predicates.js";

export interface MachineBadgeProps {
  session: DashboardSessionLike;
}

export function MachineBadge({ session }: MachineBadgeProps): React.ReactElement | null {
  const machineId = machineIdOf(session);
  if (!machineId) return null;
  return (
    <span
      data-testid="federation-machine-badge"
      title={`Federated session from ${machineId}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "1px 5px",
        borderRadius: "3px",
        fontSize: "10px",
        fontFamily: "var(--font-mono, monospace)",
        background: "var(--bg-tertiary, #2a3a4a)",
        color: "var(--text-secondary, #b0c4de)",
        border: "1px solid var(--border-secondary, #4a5a6a)",
        textTransform: "lowercase",
        letterSpacing: "0.02em",
      }}
    >
      ↗ {machineId}
    </span>
  );
}
