import { describe, expect, it } from "vitest";
import path from "node:path";
import { authorizeSpawn, deriveDelegatedBridgeOperator, type SpawnClaims, type SpawnPolicy } from "../spawn-authz.js";
import { isContained } from "../spawn-cwd.js";

const token = "a".repeat(64);
const principal = { sub: "owner@example.com", username: "owner", name: "Owner", provider: "test", exp: 2_000_000_000 };
const claims: SpawnClaims = {
  channel: "rest", principal, remoteAddress: "127.0.0.1", origin: null,
  presentedBridgeToken: null, requestedCwd: "/workspace/project", runtime: "pi",
};
const policy: SpawnPolicy = {
  now: 1_000,
  requireBrowserAuth: false, operatorUsers: ["owner"], localBridgeOperator: "owner",
  expectedBridgeToken: token, requireBridgeToken: false, trustedNetworks: ["10.0.0.0/8"],
  allowedOrigins: [], enabledRuntimes: ["pi"], permittedRoots: ["/workspace"],
  resolvedCwd: { ok: true, realPath: "/workspace/project" }, delegation: { status: "not-applicable" },
};

describe("spawn policy adversarial evidence", () => {
  for (const requireBrowserAuth of [false, true]) {
    for (const operatorUsers of [[], ["owner"]]) {
      for (const localBridgeOperator of ["owner", null]) {
        const p = { ...policy, requireBrowserAuth, operatorUsers, localBridgeOperator };
        const posture = `auth=${requireBrowserAuth}, operators=${operatorUsers.length}, delegate=${localBridgeOperator}`;

        it(`unknown channels fail closed with an otherwise valid operator: ${posture}`, () => {
          expect(authorizeSpawn(claims, p).allowed).toBe(true);
          for (const channel of [undefined, null, "future-channel", "bridge", 1, true, {}]) {
            expect(authorizeSpawn({ ...claims, channel } as never, p)).toMatchObject({ allowed: false, reason: "invalid-channel" });
          }
        });

        it(`local bridge address variants preserve delegation policy: ${posture}`, () => {
          for (const remoteAddress of [
            "127.0.0.1", "127.0.0.2", "127.42.7.9", "::1", "0:0:0:0:0:0:0:1",
            "::ffff:127.0.0.1", "::ffff:127.0.0.2", "::ffff:7f00:1", "::ffff:7f2a:709",
          ]) {
            const delegation = deriveDelegatedBridgeOperator({
              tokenVerified: true, remoteAddress, action: "spawn", operatorUsers, localBridgeOperator, now: 1_000,
            });
            expect(delegation.status, remoteAddress).toBe(localBridgeOperator === null ? "disabled" : "delegated");
            const result = authorizeSpawn({
              ...claims, channel: "bridge-ws", remoteAddress, principal: null, presentedBridgeToken: token,
            }, { ...p, delegation });
            expect(result.allowed, remoteAddress).toBe(localBridgeOperator !== null);
          }
        });
      }
    }
  }

  it("malformed claims never become an implicit browser channel", () => {
    for (const invalid of [null, undefined, 0, true, "rest", []]) {
      expect(authorizeSpawn(invalid as never, policy)).toMatchObject({ allowed: false, reason: "invalid-channel" });
    }
  });

  it("malformed peer primitives and numeric-looking strings never satisfy a trusted CIDR", () => {
    for (const channel of ["rest", "browser-ws"] as const) {
      expect(authorizeSpawn({ ...claims, channel, remoteAddress: "10.1.2.3" }, policy).allowed).toBe(true);
      for (const remoteAddress of [null, undefined, 1, true, {}, [], "10junk.1.2.3", "10.1.2.3tail", "127.0.0.999", "127.1", "localhost"]) {
        expect(authorizeSpawn({ ...claims, channel, remoteAddress } as never, policy)).toMatchObject({ allowed: false, reason: "untrusted-network" });
      }
    }
  });

  it("delegation needs literal token verification, not truthy malformed evidence", () => {
    const input = { remoteAddress: "127.0.0.1", action: "spawn", operatorUsers: ["owner"], now: 1_000 };
    expect(deriveDelegatedBridgeOperator({ ...input, tokenVerified: true }).status).toBe("delegated");
    for (const tokenVerified of [false, undefined, null, "true", 1, {}, []]) {
      expect(deriveDelegatedBridgeOperator({ ...input, tokenVerified } as never)).toEqual({ status: "refused", why: "no-token" });
    }
  });

  it("operator selection matches existing trimmed case-insensitive sub/username semantics", () => {
    for (const operatorUsers of [[" OwNeR "], [" OWNER@example.com "]]) {
      expect(authorizeSpawn(claims, { ...policy, operatorUsers }).allowed).toBe(true);
      expect(authorizeSpawn({ ...claims, principal: { ...principal, username: "owner-suffix", sub: "guest@example.com" } }, { ...policy, operatorUsers }).allowed).toBe(false);
    }
    expect(authorizeSpawn({ ...claims, principal: null }, { ...policy, operatorUsers: [] }).allowed).toBe(false);
  });

  it("wrong token primitives cannot reuse successful delegation or leak token material in results", () => {
    const delegation = deriveDelegatedBridgeOperator({ tokenVerified: true, remoteAddress: "127.0.0.1", action: "spawn", operatorUsers: ["owner"], now: 1_000 });
    const b = { ...claims, channel: "bridge-ws" as const, principal: null, presentedBridgeToken: token };
    const bp = { ...policy, delegation };
    expect(authorizeSpawn(b, bp).allowed).toBe(true);
    for (const presentedBridgeToken of [null, true, 1, {}, [], token.slice(1), token.toUpperCase()]) {
      const result = authorizeSpawn({ ...b, presentedBridgeToken } as never, bp);
      expect(result).toMatchObject({ allowed: false, reason: "untrusted-bridge" });
      expect(JSON.stringify(result)).not.toContain(token);
      expect(result).not.toHaveProperty("actor");
    }
  });

  it("relative/empty cwd evidence cannot inherit process.cwd via path.relative", () => {
    const root = process.cwd();
    const child = path.join(root, "project");
    expect(isContained(child, [root])).toBe(true);
    for (const permittedRoots of [[], [""], ["."], ["project"], [null], [1]]) {
      expect(isContained(child, permittedRoots as never)).toBe(false);
    }
    for (const realPath of ["", ".", "project", null, 1]) {
      expect(isContained(realPath as never, [root])).toBe(false);
    }
  });
});
