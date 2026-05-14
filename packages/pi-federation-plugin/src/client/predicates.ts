/**
 * Predicates for federation plugin's session-card-badge claim.
 *
 * `isFederatedSession` returns true when the session's id carries a machineId
 * prefix (e.g. "imac:abc123..."). The federation server entry prefixes ids
 * before re-broadcasting peer events; predicate matches on the same shape.
 */

export interface DashboardSessionLike {
  id: string;
  [k: string]: unknown;
}

const SESSION_ID_PREFIX_RE = /^([a-z0-9_-]+):[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

export function isFederatedSession(session: DashboardSessionLike): boolean {
  return typeof session.id === "string" && SESSION_ID_PREFIX_RE.test(session.id);
}

/** Extract the machineId prefix from a federated session id, or null. */
export function machineIdOf(session: DashboardSessionLike): string | null {
  const m = session.id?.match(SESSION_ID_PREFIX_RE);
  return m ? m[1] : null;
}
