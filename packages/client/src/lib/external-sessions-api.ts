/**
 * Client fetch helpers for the read-only external-session viewer.
 *
 * Uses `getApiBase()` for the cross-origin-aware base (same idiom as
 * ActiveOperatorSurfaces / git-api). Read-only: only GETs here — there is no
 * write path to an external pane.
 */
import { getApiBase } from "./api-context.js";
import type {
  ExternalRuntime,
  ExternalSession,
  ExternalSessionState,
} from "@blackbelt-technology/pi-dashboard-shared/external-session.js";

export type {
  ExternalRuntime,
  ExternalSession,
  ExternalSessionState,
} from "@blackbelt-technology/pi-dashboard-shared/external-session.js";

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
