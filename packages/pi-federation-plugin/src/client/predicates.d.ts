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
export declare function isFederatedSession(session: DashboardSessionLike): boolean;
/** Extract the machineId prefix from a federated session id, or null. */
export declare function machineIdOf(session: DashboardSessionLike): string | null;
