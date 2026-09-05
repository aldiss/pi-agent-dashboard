import type { TokenPayload } from "../auth.js";
import { hasUsableSub } from "../auth.js";
import { isOperator } from "../session-authz.js";
import type { SpawnGate } from "../spawn-authz.js";

const OPERATOR: TokenPayload = {
  sub: "spawn-operator@example.com", username: "spawn-operator", name: "Spawn Operator",
  provider: "test", exp: 2_000_000_000,
};

/** Handler fixture: directory/process work is stubbed; operator identity remains mandatory. */
export function createSpawnTestContext(options: {
  principal?: TokenPayload | null;
  operatorUsers?: string[];
  requireBrowserAuth?: boolean;
} = {}) {
  const principal = options.principal === undefined ? OPERATOR : options.principal;
  const operatorUsers = options.operatorUsers ?? [principal?.sub ?? OPERATOR.sub];
  const spawnGate: SpawnGate = (claims) => {
    if (!hasUsableSub(claims.principal)) return { allowed: false, reason: "no-principal", httpStatus: 401 };
    if (operatorUsers.length && !isOperator(claims.principal, operatorUsers)) {
      return { allowed: false, reason: "operator-only", httpStatus: 403 };
    }
    return {
      allowed: true, cwd: claims.requestedCwd, permittedRoots: [claims.requestedCwd],
      actor: { sub: claims.principal!.sub, provider: claims.principal!.provider },
    };
  };
  return {
    principal, operatorUsers, requireBrowserAuth: options.requireBrowserAuth ?? false,
    remoteAddress: "127.0.0.1", origin: null, spawnGate,
  };
}
