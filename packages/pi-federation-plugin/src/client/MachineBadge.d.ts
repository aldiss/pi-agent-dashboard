/**
 * MachineBadge — session-card badge that renders the peer's machineId
 * for federated sessions.
 *
 * The badge claim is predicated on `isFederatedSession`; the slot host
 * in dashboard-plugin-runtime's slot-consumers.tsx invokes the predicate
 * before rendering, so we can rely on session being a federated row here.
 */
import React from "react";
import { type DashboardSessionLike } from "./predicates.js";
export interface MachineBadgeProps {
    session: DashboardSessionLike;
}
export declare function MachineBadge({ session }: MachineBadgeProps): React.ReactElement | null;
