import type { SessionRuntime } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import { verifyBridgeToken } from "@blackbelt-technology/pi-dashboard-shared/bridge-token.js";
import { isIP } from "node:net";
import { hasUsableSub, type TokenPayload } from "./auth.js";
import { isBypassedHost } from "./localhost-guard.js";
import { isOperator } from "./session-authz.js";
import { isContained, type ResolvedCwd } from "./spawn-cwd.js";

export interface SpawnClaims {
  channel: "rest" | "browser-ws" | "bridge-ws";
  principal: TokenPayload | null;
  remoteAddress: string | null;
  origin: string | null;
  forwarded?: boolean;
  presentedBridgeToken: string | null;
  requestedCwd: string;
  runtime: SessionRuntime;
}

export type DelegationOutcome =
  | { status: "delegated"; principal: TokenPayload }
  | { status: "disabled" }
  | { status: "refused"; why: "no-token" | "remote" | "not-spawn" | "operator-mismatch" };

export interface SpawnPolicy {
  /** Decision time supplied by caller; includes already-bound socket principals. */
  now: number;
  requireBrowserAuth: boolean;
  operatorUsers: readonly string[];
  localBridgeOperator?: string | null;
  expectedBridgeToken: string | null;
  requireBridgeToken: boolean;
  trustedNetworks: readonly string[];
  allowedOrigins: readonly string[];
  enabledRuntimes: readonly SessionRuntime[];
  permittedRoots: readonly string[];
  resolvedCwd: ResolvedCwd;
  delegation: DelegationOutcome | { status: "not-applicable" };
}

export type SpawnDenyReason =
  | "invalid-channel" | "no-principal" | "invalid-principal" | "operator-only"
  | "untrusted-network" | "untrusted-origin" | "untrusted-bridge"
  | "delegation-refused" | "cwd-not-permitted" | "runtime-not-enabled"
  | "spawn-policy-unavailable";

export type SpawnAuthzResult =
  | { allowed: true; cwd: string; permittedRoots: readonly string[]; actor: { sub: string; provider: string } }
  | { allowed: false; reason: SpawnDenyReason; httpStatus: 401 | 403 };

export type SpawnGate = (claims: SpawnClaims) => SpawnAuthzResult;

function isSpawnLoopback(address: string | null): boolean {
  if (typeof address !== "string") return false;
  const family = isIP(address);
  if (family === 4) return address.startsWith("127.");
  if (family !== 6) return false;
  try {
    const host = new URL(`http://[${address}]/`).hostname;
    return host === "[::1]" || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(host);
  } catch {
    return false;
  }
}

/** In-memory identity for one delegation decision. Never signed or used as a speaker. */
export function deriveDelegatedBridgeOperator(input: {
  tokenVerified: boolean;
  remoteAddress: string | null;
  forwarded?: boolean;
  action: string;
  operatorUsers: readonly string[];
  localBridgeOperator?: string | null;
  now: number;
}): DelegationOutcome {
  if (input.action !== "spawn" && input.action !== "send_prompt") return { status: "refused", why: "not-spawn" };
  if (input.localBridgeOperator === null) return { status: "disabled" };
  if (input.tokenVerified !== true) return { status: "refused", why: "no-token" };
  if (!isSpawnLoopback(input.remoteAddress) || input.forwarded) {
    return { status: "refused", why: "remote" };
  }
  const users = input.operatorUsers.map(u => u.trim()).filter(Boolean);
  const configured = input.localBridgeOperator?.trim();
  if (configured && users.length > 0 && !users.some(u => u.toLowerCase() === configured.toLowerCase())) {
    return { status: "refused", why: "operator-mismatch" };
  }
  const sub = users.length ? configured || users[0] : "local-bridge";
  return {
    status: "delegated",
    principal: { sub, username: sub, name: "pi bridge (delegated)", provider: "local-bridge-delegation", exp: Math.floor(input.now / 1000) + 60 },
  };
}

/** Pure, independently sufficient spawn decision. No base-gate verdict is assumed. */
export function authorizeSpawn(claims: SpawnClaims, policy: SpawnPolicy): SpawnAuthzResult {
  const deny = (reason: SpawnDenyReason, httpStatus: 401 | 403 = 403): SpawnAuthzResult => ({ allowed: false, reason, httpStatus });
  if (!claims || !["rest", "browser-ws", "bridge-ws"].includes(claims.channel)) return deny("invalid-channel");
  if (!policy.enabledRuntimes.includes(claims.runtime)) return deny("runtime-not-enabled");

  let principal = claims.principal;
  if (claims.channel === "bridge-ws") {
    if (!verifyBridgeToken(claims.presentedBridgeToken, policy.expectedBridgeToken)) return deny("untrusted-bridge");
    if (policy.localBridgeOperator === null || policy.delegation.status !== "delegated"
      || !isSpawnLoopback(claims.remoteAddress) || claims.forwarded) {
      return deny("delegation-refused");
    }
    principal = policy.delegation.principal;
  }
  if (typeof claims.remoteAddress !== "string" || isIP(claims.remoteAddress) === 0 || (!isSpawnLoopback(claims.remoteAddress)
    && !isBypassedHost(claims.remoteAddress, [...policy.trustedNetworks]))) return deny("untrusted-network");
  if (claims.origin !== null && !policy.allowedOrigins.includes(claims.origin)) return deny("untrusted-origin");
  // Spawn needs credentials even when the generic session-action gate is inert.
  if (!principal) return deny("no-principal", 401);
  if (!hasUsableSub(principal) || !Number.isFinite(principal.exp) || principal.exp * 1000 <= policy.now) return deny("invalid-principal", 401);
  if (policy.operatorUsers.length && !isOperator(principal, [...policy.operatorUsers])) return deny("operator-only");
  if (!policy.resolvedCwd.ok || !isContained(policy.resolvedCwd.realPath, policy.permittedRoots)) return deny("cwd-not-permitted");
  return { allowed: true, cwd: policy.resolvedCwd.realPath, permittedRoots: policy.permittedRoots, actor: { sub: principal.sub, provider: principal.provider } };
}
