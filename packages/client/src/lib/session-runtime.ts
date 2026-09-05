import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";

export function hasResumeTarget(session: DashboardSession): boolean {
  return session.runtime === "codex" ? Boolean(session.codexThreadId) : Boolean(session.sessionFile);
}
