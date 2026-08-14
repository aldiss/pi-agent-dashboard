import type { ExternalSession } from "@blackbelt-technology/pi-dashboard-shared/external-session.js";
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";

function finiteTimestamp(value: number | null | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Maps a read-only tmux pane into the ordinary session-card model. */
export function mapExternalSession(session: ExternalSession): DashboardSession {
  const startedAt = finiteTimestamp(session.firstSeenAt, Date.now());
  const outputChangedAt = typeof session.outputChangedAt === "number"
    && Number.isFinite(session.outputChangedAt)
    ? session.outputChangedAt
    : undefined;
  const lastActivityAt = outputChangedAt
    ?? finiteTimestamp(session.lastLiveAt, startedAt);
  const endedAt = session.state === "ended"
    ? finiteTimestamp(session.endedAt, lastActivityAt)
    : undefined;
  const model = session.model?.trim() || "unknown model";
  const effort = session.effort?.trim() || undefined;

  return {
    id: session.id,
    cwd: session.cwd ?? "",
    name: session.title || session.tmuxSession,
    source: session.runtime,
    status: session.state === "ended" ? "ended" : "active",
    model: `${session.runtime}/${model}`,
    thinkingLevel: effort,
    startedAt,
    lastActivityAt,
    endedAt,
    bridgeConnected: true,
    pid: session.runtimePid ?? undefined,
    currentTool: null,
    external: {
      runtime: session.runtime,
      tmuxSession: session.tmuxSession,
      readOnly: true,
      outputChangedAt,
      lineCount: Number.isFinite(session.lineCount) ? session.lineCount : undefined,
    },
  };
}

/** Builds the card list without adding external panes to the WebSocket-owned map. */
export function mergeExternalSessions(
  sessions: ReadonlyMap<string, DashboardSession>,
  externalSessions: readonly ExternalSession[],
): DashboardSession[] {
  return [
    ...sessions.values(),
    ...externalSessions.map(mapExternalSession),
  ];
}
