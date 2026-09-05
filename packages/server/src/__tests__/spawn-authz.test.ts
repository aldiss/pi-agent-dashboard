import { describe, expect, it, vi } from "vitest";
import type { TokenPayload } from "../auth.js";
import { authorizeSessionAction, SESSION_WRITE_ACTION_CLASS } from "../session-authz.js";
import { authorizeSpawn, deriveDelegatedBridgeOperator, type SpawnClaims, type SpawnPolicy } from "../spawn-authz.js";

const token = "a".repeat(64);
const principal: TokenPayload = { sub: "owner", username: "owner", name: "Owner", provider: "test", exp: 2_000_000_000 };
const claims: SpawnClaims = {
  channel: "rest", principal, remoteAddress: "127.0.0.1", origin: "http://localhost:8000",
  presentedBridgeToken: null, requestedCwd: "/workspace/project", runtime: "pi",
};
const policy: SpawnPolicy = {
  now: 1_000,
  requireBrowserAuth: false, operatorUsers: ["owner"], localBridgeOperator: undefined,
  expectedBridgeToken: token, requireBridgeToken: false, trustedNetworks: ["10.0.0.0/8"],
  allowedOrigins: ["http://localhost:8000"], enabledRuntimes: ["pi"],
  permittedRoots: ["/workspace"], resolvedCwd: { ok: true, realPath: "/workspace/project" },
  delegation: { status: "not-applicable" },
};

describe("base authorization posture map (unchanged gate)", () => {
  for (const requireBrowserAuth of [false, true]) {
    for (const operatorUsers of [[], ["owner"]]) {
      for (const localBridgeOperator of ["owner", null]) {
        const posture = `auth=${requireBrowserAuth}, operators=${operatorUsers.length}, delegate=${localBridgeOperator}`;
        it(posture, () => {
          const decide = (actor: any, action = "spawn", extra = {}) => authorizeSessionAction({
            actor, action, requireBrowserAuth, operatorUsers, ...extra,
          });
          expect(decide({ kind: "human", principal: null }).allowed).toBe(!requireBrowserAuth);
          expect(decide({ kind: "human", principal: { ...principal, sub: " " } }).allowed).toBe(!requireBrowserAuth);
          expect(decide({ kind: "service", id: "bridge" }).allowed).toBe(!requireBrowserAuth);
          expect(decide({ kind: "human", principal })).toEqual({ allowed: true });
          expect(decide({ kind: "human", principal: { ...principal, sub: "guest", username: "guest" } }).allowed)
            .toBe(!requireBrowserAuth || operatorUsers.length === 0);
          expect(decide({ kind: "human", principal }, "future-action").allowed).toBe(!requireBrowserAuth);

          const tracker = { canAdmit: vi.fn(() => ({ admissible: false })), commit: vi.fn() };
          const cellAccess = { enabled: true, canViewSession: vi.fn(() => false) };
          expect(decide({ kind: "human", principal }, "spawn", { operatorSet: tracker, cellAccess })).toEqual({ allowed: true });
          expect(tracker.canAdmit).not.toHaveBeenCalled();
          expect(cellAccess.canViewSession).not.toHaveBeenCalled();
          expect(decide({ kind: "human", principal }, "send_prompt", { cellAccess }).reason)
            .toBe(requireBrowserAuth ? "session-unavailable" : undefined);
          expect(decide({ kind: "human", principal }, "send_prompt", { operatorSet: tracker }).reason)
            .toBe(requireBrowserAuth ? "session-full" : undefined);
          expect(decide({ kind: "human", principal }, "spawn", { operatorSet: tracker, sessionId: "unexpected-target" }).reason)
            .toBe(requireBrowserAuth ? "session-full" : undefined);
          expect(tracker.commit).not.toHaveBeenCalled();
        });
      }
    }
  }
});

describe("independently sufficient spawn authorization", () => {
  for (const requireBrowserAuth of [false, true]) {
    describe(`browser auth ${requireBrowserAuth ? "on" : "off"}`, () => {
      const p = { ...policy, requireBrowserAuth };
      it("allows a verified operator, never anonymous or unusable identity in either browser door", () => {
        for (const channel of ["rest", "browser-ws"] as const) {
          expect(authorizeSpawn({ ...claims, channel }, p).allowed).toBe(true);
          expect(authorizeSpawn({ ...claims, channel, principal: null }, p)).toMatchObject({ allowed: false, reason: "no-principal" });
          expect(authorizeSpawn({ ...claims, channel, principal: { ...principal, sub: "" } }, p)).toMatchObject({ allowed: false, reason: "invalid-principal" });
          expect(authorizeSpawn({ ...claims, channel, principal: { ...principal, sub: "guest", username: "guest" } }, p)).toMatchObject({ allowed: false, reason: "operator-only" });
        }
      });
      it("does not treat trusted network placement or a body-supplied bridge credential as browser identity", () => {
        expect(authorizeSpawn({ ...claims, principal: null, remoteAddress: "10.1.2.3", presentedBridgeToken: token }, p).allowed).toBe(false);
      });
      it("rejects missing peer, untrusted network, foreign origin and unenabled runtime", () => {
        expect(authorizeSpawn({ ...claims, remoteAddress: null }, p)).toMatchObject({ allowed: false, reason: "untrusted-network" });
        expect(authorizeSpawn({ ...claims, remoteAddress: "203.0.113.5" }, p)).toMatchObject({ allowed: false, reason: "untrusted-network" });
        expect(authorizeSpawn({ ...claims, origin: "https://hostile.example" }, p)).toMatchObject({ allowed: false, reason: "untrusted-origin" });
        expect(authorizeSpawn({ ...claims, runtime: "codex" }, p)).toMatchObject({ allowed: false, reason: "runtime-not-enabled" });
        expect(authorizeSpawn({ ...claims, runtime: "future" as any }, p).allowed).toBe(false);
      });
      it("fails closed on unresolvable, uncontained and empty-root cwd policy", () => {
        expect(authorizeSpawn(claims, { ...p, resolvedCwd: { ok: false, problem: "missing" } }).allowed).toBe(false);
        expect(authorizeSpawn(claims, { ...p, resolvedCwd: { ok: true, realPath: "/workspace-other" } }).allowed).toBe(false);
        expect(authorizeSpawn(claims, { ...p, permittedRoots: [] })).toMatchObject({ allowed: false, reason: "cwd-not-permitted" });
      });
      for (const operatorUsers of [[], ["owner"], ["first", "owner"]]) {
        it(`preserves local /new with ${operatorUsers.length} operators and denies every bridge failure itself`, () => {
          const delegation = deriveDelegatedBridgeOperator({ tokenVerified: true, remoteAddress: "127.0.0.1", action: "spawn", operatorUsers, now: 1_000 });
          expect(delegation.status).toBe("delegated");
          const b = { ...claims, channel: "bridge-ws" as const, principal: null, origin: null, presentedBridgeToken: token };
          const bp: SpawnPolicy = { ...p, operatorUsers, delegation };
          expect(authorizeSpawn(b, bp).allowed).toBe(true);
          if (delegation.status !== "delegated") throw new Error("delegation missing");
          expect(authorizeSessionAction({ actor: { kind: "human", principal: delegation.principal }, action: "spawn", requireBrowserAuth, operatorUsers }).allowed).toBe(true);
          for (const presentedBridgeToken of [null, "", "wrong", "b".repeat(64)]) {
            expect(authorizeSpawn({ ...b, presentedBridgeToken }, bp)).toMatchObject({ allowed: false, reason: "untrusted-bridge" });
          }
          expect(authorizeSpawn(b, { ...bp, expectedBridgeToken: null }).allowed).toBe(false);
          // Deliberately stale/incorrect successful-delegation evidence must not defeat independent checks.
          expect(authorizeSpawn(b, { ...bp, localBridgeOperator: null })).toMatchObject({ allowed: false, reason: "delegation-refused" });
          expect(authorizeSpawn({ ...b, remoteAddress: "10.1.2.3" }, bp)).toMatchObject({ allowed: false, reason: "delegation-refused" });
          expect(authorizeSpawn({ ...b, forwarded: true }, bp).allowed).toBe(false);
          for (const delegation of [{ status: "refused", why: "remote" }, { status: "disabled" }, { status: "not-applicable" }] as const) {
            expect(authorizeSpawn(b, { ...bp, delegation }).allowed).toBe(false);
          }
        });
      }
    });
  }
});

describe("bridge delegation is an allow-list of exactly spawn", () => {
  const input = { tokenVerified: true, remoteAddress: "127.0.0.1", operatorUsers: ["owner"], now: 1_000 };
  it("derives scope tests from the real action map, and refuses an unknown future action", () => {
    expect(Object.values(SESSION_WRITE_ACTION_CLASS).filter(v => v === "operator-only").length).toBeGreaterThanOrEqual(25);
    for (const action of [...Object.keys(SESSION_WRITE_ACTION_CLASS), "future-action"]) {
      expect(deriveDelegatedBridgeOperator({ ...input, action }).status).toBe(action === "spawn" ? "delegated" : "refused");
    }
  });
  it("has explicit refusal and disable outcomes and no remote/token fallback", () => {
    expect(deriveDelegatedBridgeOperator({ ...input, action: "spawn", localBridgeOperator: null })).toEqual({ status: "disabled" });
    expect(deriveDelegatedBridgeOperator({ ...input, action: "spawn", tokenVerified: false }).status).toBe("refused");
    expect(deriveDelegatedBridgeOperator({ ...input, action: "spawn", remoteAddress: "10.1.2.3" }).status).toBe("refused");
  });
  it("uses synthetic identity only with empty operators; honors explicit configured identity", () => {
    expect(deriveDelegatedBridgeOperator({ ...input, action: "spawn", operatorUsers: [] })).toMatchObject({ status: "delegated", principal: { sub: "local-bridge", provider: "local-bridge-delegation" } });
    expect(deriveDelegatedBridgeOperator({ ...input, action: "spawn", operatorUsers: ["first", "owner"], localBridgeOperator: "owner" })).toMatchObject({ status: "delegated", principal: { sub: "owner" } });
    expect(deriveDelegatedBridgeOperator({ ...input, action: "spawn", localBridgeOperator: "outsider" }).status).toBe("refused");
  });
});
