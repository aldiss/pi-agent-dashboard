/**
 * Agent-as-presence (multi-operator, Surface B / BA-4 / dl-6010 — Stream-2 D fill).
 *
 * The session presence surface (see `session-presence-tracker.ts` +
 * `presence_update`) is the union of the distinct human co-drivers AND the agent
 * participant this interface contributes. B shipped this as a NO-OP (`null` for
 * every session); D FILLS it — resolving the live agent participant for a
 * session — WITHOUT re-implementing the presence UI or the presence tracker (B
 * owns those; D extends THROUGH this single ratified seam).
 *
 * ── Live-agent signal (own-hand recon, NOT fabricated) ───────────────────────
 * The server-side `SessionManager` IS the registry of connected pi instances (a
 * `DashboardSession` = "a dashboard session representing a connected pi
 * instance"). Its `status` (`active|idle|streaming|ended`) is the authoritative
 * liveness bit: `!== "ended"` ⇒ the pi agent process is live. This is the SAME
 * liveness predicate the rest of the server already gates on (server.ts session-
 * write branches). D reads it through a narrow injected source so this module
 * stays decoupled from `SessionManager` (and unit-testable without one) and the
 * frozen `getAgentPresence(sessionId)` signature does not change shape.
 *
 * ── Flag discipline (byte-unchanged when off) ────────────────────────────────
 * The source is configured (server.ts) ONLY when `auth.requireBrowserAuth` is
 * ON. With the flag OFF nothing configures it → `getAgentPresence` returns
 * `null` for every session → the presence set is exactly as B shipped it
 * (humans-only, and empty in single-operator mode). So a single-operator server
 * never grows an agent participant (no `presence_update` perturbation).
 */
import type { PresenceParticipant, SessionStatus } from "@blackbelt-technology/pi-dashboard-shared/types.js";

/**
 * The narrow live-agent signal D reads: given a sessionId, the session's
 * liveness `status` + optional display `name`, or null/undefined when the
 * session is unknown. Injected (server.ts) so this module never imports
 * `SessionManager` — it depends only on the two fields it needs.
 */
export type AgentPresenceSource = (
  sessionId: string,
) => { status: SessionStatus; name?: string } | null | undefined;

/**
 * The configured source, or null when unconfigured (single-operator / flag OFF /
 * pre-startup / a test that did not opt in). Null → `getAgentPresence` is the
 * B-era NO-OP (returns null), so behavior is byte-unchanged.
 */
let agentSource: AgentPresenceSource | null = null;

/**
 * Wire the live-agent signal. Called at server startup ONLY when the
 * multi-operator flag is ON (so flag-off servers stay NO-OP). Idempotent — the
 * last call wins.
 */
export function configureAgentPresence(source: AgentPresenceSource): void {
  agentSource = source;
}

/** Clear the configured source (test isolation / flag-off restart). */
export function resetAgentPresence(): void {
  agentSource = null;
}

/**
 * Resolve the agent participant present in a session, or `null` when there is
 * none (unconfigured, unknown session, or an ENDED session whose pi process is
 * gone). The agent id is namespaced (`agent:<sessionId>`) so it can never
 * collide with a human participant's `sub` (an email in the current provider
 * set) in the unioned presence set. Display prefers the session's `name` (the
 * themed/assigned session label), else a stable generic `"agent"`.
 */
export function getAgentPresence(sessionId: string): PresenceParticipant | null {
  if (!agentSource) return null; // B-era NO-OP: flag off / unconfigured.
  const session = agentSource(sessionId);
  if (!session || session.status === "ended") return null; // no live agent.
  const name = typeof session.name === "string" ? session.name.trim() : "";
  return {
    id: `agent:${sessionId}`,
    kind: "agent",
    display: name.length > 0 ? name : "agent",
  };
}
