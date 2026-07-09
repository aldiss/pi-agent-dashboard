/**
 * Greenfield agent-presence interface (multi-operator, Surface B / BA-4 / dl-6010).
 *
 * The session presence surface (see `session-presence-tracker.ts` +
 * `presence_update`) is the union of the distinct human co-drivers AND whatever
 * agent participant this interface contributes. TODAY this is a NO-OP: it
 * returns `null` (no agent participant) for every session, so the presence set
 * is humans-only and no existing event is perturbed.
 *
 * ── D-FILLER MARKER ──────────────────────────────────────────────────────────
 * D fills this in later (post-C-land, when D un-defers). D implements the real
 * agent source HERE — resolving the live agent participant for a session (id,
 * display) — WITHOUT re-implementing the presence UI or the presence tracker.
 * B OWNS the presence surface; D extends it THROUGH this single seam. Do NOT
 * build an agent source now; ship the NO-OP + this marker.
 */
import type { PresenceParticipant } from "@blackbelt-technology/pi-dashboard-shared/types.js";

/**
 * Resolve the agent participant present in a session, or `null` when there is
 * none. NO-OP today (always `null`). D replaces the body; the SIGNATURE is the
 * ratified seam and must not change shape.
 */
export function getAgentPresence(_sessionId: string): PresenceParticipant | null {
  // D-FILLER: return the live agent participant for `_sessionId` here.
  return null;
}
