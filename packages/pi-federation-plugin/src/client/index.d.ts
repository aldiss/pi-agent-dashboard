/**
 * Federation plugin — client entry barrel.
 *
 * Components claimed by `pi-dashboard-plugin` in package.json:
 *   - session-card-badge → MachineBadge          (predicate: isFederatedSession)
 *   - settings-section   → FederationSettings    (general tab)
 *
 * Per Schema 7 §3.5 + investigator #1 §6.3 federation-hook sketch.
 */
export { isFederatedSession } from "./predicates.js";
export { MachineBadge } from "./MachineBadge.js";
export { FederationSettings } from "./FederationSettings.js";
