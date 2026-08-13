/**
 * Client fetch helpers for the read-only external-session viewer.
 *
 * Uses `getApiBase()` for the cross-origin-aware base (same idiom as
 * ActiveOperatorSurfaces / git-api). Read-only: only GETs here — there is no
 * write path to an external pane.
 */
import { getApiBase } from "./api-context.js";

export type ExternalRuntime = "codex" | "claude-code";
export type ExternalSessionState = "live" | "ended";

export interface ExternalSession {
  id: string;
  runtime: ExternalRuntime;
  tmuxSession: string;
  tmuxSocket: string;
  title: string;
  cwd: string | null;
  runtimePid: number | null;
  state: ExternalSessionState;
  model: string | null;
  effort: string | null;
  firstSeenAt: number;
  lastLiveAt: number;
  endedAt: number | null;
  output: string;
  outputAt: number;
  lineCount: number;
}

export interface ExternalSessionCapture {
  id: string;
  output: string;
  lineCount: number;
  state: ExternalSessionState;
  capturedAt: number;
}

/** GET /api/external-sessions → the current snapshot list. */
export async function fetchExternalSessions(): Promise<ExternalSession[]> {
  const res = await fetch(`${getApiBase()}/api/external-sessions`);
  if (!res.ok) throw new Error(`external-sessions ${res.status}`);
  const body = (await res.json()) as { sessions?: ExternalSession[] };
  return body.sessions ?? [];
}

/** GET /api/external-sessions/:id/capture → a fresh (live) or frozen (ended) read. */
export async function fetchExternalSessionCapture(id: string): Promise<ExternalSessionCapture> {
  const res = await fetch(
    `${getApiBase()}/api/external-sessions/${encodeURIComponent(id)}/capture`,
  );
  if (!res.ok) throw new Error(`external-session capture ${res.status}`);
  return (await res.json()) as ExternalSessionCapture;
}
