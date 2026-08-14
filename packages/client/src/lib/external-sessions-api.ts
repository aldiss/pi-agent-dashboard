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
  ExternalSessionDriver,
  ExternalSessionOwner,
  ExternalSessionState,
  ExternalSessionsResponse,
  ExternalSessionTranscriptResponse,
  ExternalTranscriptEntry,
  ExternalTranscriptEntryKind,
  ExternalTranscriptSource,
} from "@blackbelt-technology/pi-dashboard-shared/external-session.js";

export type {
  ExternalRuntime,
  ExternalSession,
  ExternalSessionDriver,
  ExternalSessionOwner,
  ExternalSessionState,
  ExternalSessionsResponse,
  ExternalSessionTranscriptResponse,
  ExternalTranscriptEntry,
  ExternalTranscriptEntryKind,
  ExternalTranscriptSource,
} from "@blackbelt-technology/pi-dashboard-shared/external-session.js";

export interface ExternalSessionCapture {
  id: string;
  output: string;
  lineCount: number;
  state: ExternalSessionState;
  capturedAt: number;
}

/** GET /api/external-sessions → sessions plus cell ownership metadata. */
export async function fetchExternalSessionsSnapshot(): Promise<ExternalSessionsResponse> {
  const res = await fetch(`${getApiBase()}/api/external-sessions`);
  if (!res.ok) throw new Error(`external-sessions ${res.status}`);
  const body = (await res.json()) as Partial<ExternalSessionsResponse>;
  return {
    sessions: body.sessions ?? [],
    owners: body.owners ?? {},
    drivers: body.drivers ?? [],
  };
}

/** Compatibility list API for existing callers. */
export async function fetchExternalSessions(): Promise<ExternalSession[]> {
  return (await fetchExternalSessionsSnapshot()).sessions;
}

/** GET /api/external-sessions/:id/capture → a fresh (live) or frozen (ended) read. */
export async function fetchExternalSessionCapture(id: string): Promise<ExternalSessionCapture> {
  const res = await fetch(
    `${getApiBase()}/api/external-sessions/${encodeURIComponent(id)}/capture`,
  );
  if (!res.ok) throw new Error(`external-session capture ${res.status}`);
  return (await res.json()) as ExternalSessionCapture;
}

/** GET /api/external-sessions/:id/transcript → normalized runtime transcript or capture fallback. */
export async function fetchExternalSessionTranscript(
  id: string,
): Promise<ExternalSessionTranscriptResponse> {
  const res = await fetch(
    `${getApiBase()}/api/external-sessions/${encodeURIComponent(id)}/transcript`,
  );
  if (!res.ok) throw new Error(`external-session transcript ${res.status}`);
  return (await res.json()) as ExternalSessionTranscriptResponse;
}
