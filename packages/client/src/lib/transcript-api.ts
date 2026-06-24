import { getApiBase } from "./api-context.js";
import type { DashboardEvent } from "@blackbelt-technology/pi-dashboard-shared/types.js";

/**
 * One backward-pager window of a Claude-Code session transcript.
 * Mirrors the server's `GET /api/session/:id/transcript` response.
 * See change: perf/cc-viewing-payload-fix (Track 2, Fix B).
 */
export interface TranscriptWindow {
  /** Browser events (reducer-ready) for this window, chronological within it. */
  events: DashboardEvent[];
  /** Byte offset where this window starts — pass as the next call's `before`. */
  nextBeforeOffset: number;
  /** True once the window reaches byte 0 — no earlier history remains. */
  atStart: boolean;
}

/**
 * Fetch one earlier window of a CC session's transcript. `before` is the byte
 * offset to read backward from (omit on the first call to get the tail window
 * + its start cursor). Returns `null` on any error so callers can degrade the
 * "▲ Load earlier" affordance without throwing into render.
 */
export async function fetchTranscriptWindow(
  sessionId: string,
  before?: number,
  limit = 262144,
): Promise<TranscriptWindow | null> {
  try {
    const params = new URLSearchParams();
    if (before != null) params.set("before", String(before));
    params.set("limit", String(limit));
    const res = await fetch(
      `${getApiBase()}/api/session/${encodeURIComponent(sessionId)}/transcript?${params.toString()}`,
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { success: boolean; data?: TranscriptWindow; error?: string };
    if (!body.success || !body.data) return null;
    return body.data;
  } catch {
    return null;
  }
}
