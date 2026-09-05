import { verifyBridgeToken } from "@blackbelt-technology/pi-dashboard-shared/bridge-token.js";
import { authorizeSessionAction } from "./session-authz.js";
import { authorizeSpawn, deriveDelegatedBridgeOperator, type SpawnAuthzResult, type SpawnClaims, type SpawnGate, type SpawnPolicy } from "./spawn-authz.js";
import { resolveSpawnCwd } from "./spawn-cwd.js";

export interface SpawnBoundaryPolicy extends Omit<SpawnPolicy, "now" | "resolvedCwd" | "delegation" | "permittedRoots" | "allowedOrigins"> {
  getPermittedRoots(): readonly string[];
  getAllowedOrigins(): readonly string[];
  audit?(actor: { sub: string; provider: string }, claims: SpawnClaims): void;
}

/** One startup-frozen authorization policy shared by every spawn ingress. */
export function createSpawnGate(input: SpawnBoundaryPolicy): SpawnGate {
  const policy = { ...input, operatorUsers: [...input.operatorUsers], enabledRuntimes: [...input.enabledRuntimes] };
  return (claims) => {
    const now = Date.now();
    const delegation = claims.channel === "bridge-ws"
      ? deriveDelegatedBridgeOperator({
        tokenVerified: verifyBridgeToken(claims.presentedBridgeToken, policy.expectedBridgeToken),
        remoteAddress: claims.remoteAddress, forwarded: claims.forwarded, action: "spawn",
        operatorUsers: policy.operatorUsers, localBridgeOperator: policy.localBridgeOperator, now,
      })
      : { status: "not-applicable" as const };
    const actor = claims.channel === "bridge-ws"
      ? delegation.status === "delegated"
        ? { kind: "human" as const, principal: delegation.principal }
        : { kind: "service" as const, id: "pi-bridge" }
      : { kind: "human" as const, principal: claims.principal };
    // No sessionId: spawn creates a session; it cannot consume an admission slot.
    const base = authorizeSessionAction({ actor, action: "spawn", requireBrowserAuth: policy.requireBrowserAuth, operatorUsers: policy.operatorUsers });
    if (!base.allowed) {
      const reason = base.reason === "no-principal" || base.reason === "invalid-principal" ? base.reason : "operator-only";
      return { allowed: false, reason, httpStatus: reason === "operator-only" ? 403 : 401 };
    }
    const decision = authorizeSpawn(claims, {
      ...policy, now, delegation, allowedOrigins: policy.getAllowedOrigins(),
      permittedRoots: policy.getPermittedRoots(), resolvedCwd: resolveSpawnCwd(claims.requestedCwd),
    });
    if (decision.allowed) policy.audit?.(decision.actor, claims);
    return decision;
  };
}

/** Missing policy injection never recreates a permissive spawn door. */
export function runSpawnGate(gate: SpawnGate | undefined, claims: SpawnClaims): SpawnAuthzResult {
  return gate?.(claims) ?? { allowed: false, reason: "spawn-policy-unavailable", httpStatus: 403 };
}
