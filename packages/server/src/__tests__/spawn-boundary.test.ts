import { describe, expect, it, vi } from "vitest";
import { createSpawnGate, runSpawnGate } from "../spawn-boundary.js";
import type { SpawnClaims } from "../spawn-authz.js";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";

const token = "c".repeat(64);
const cwd = realpathSync(tmpdir());
const claims: SpawnClaims = { channel: "bridge-ws", principal: null, remoteAddress: "127.0.0.1", origin: null, presentedBridgeToken: token, requestedCwd: cwd, runtime: "pi" };

describe("base-first spawn boundary", () => {
  for (const requireBrowserAuth of [false, true]) {
    for (const operatorUsers of [[], ["owner"]]) {
      it(`composes delegated /new and its denials (auth=${requireBrowserAuth}, operators=${operatorUsers.length})`, () => {
        const policy = { requireBrowserAuth, operatorUsers, expectedBridgeToken: token, requireBridgeToken: false,
          enabledRuntimes: ["pi"] as const, trustedNetworks: ["10.0.0.0/8"], getPermittedRoots: () => [cwd], getAllowedOrigins: () => [], audit: vi.fn() };
        const gate = createSpawnGate(policy);
        expect(gate(claims).allowed).toBe(true);
        expect(gate({ ...claims, presentedBridgeToken: null }).allowed).toBe(false);
        expect(gate({ ...claims, remoteAddress: "10.1.2.3" }).allowed).toBe(false);
        expect(createSpawnGate({ ...policy, localBridgeOperator: null })(claims).allowed).toBe(false);
        expect(policy.audit).toHaveBeenCalledWith(expect.objectContaining({ provider: "local-bridge-delegation" }), claims);
      });
    }
  }
  it("runs the base refusal before filesystem policy construction", () => {
    const getPermittedRoots = vi.fn(() => [cwd]);
    const gate = createSpawnGate({ requireBrowserAuth: true, operatorUsers: ["owner"], localBridgeOperator: null,
      expectedBridgeToken: token, requireBridgeToken: false, enabledRuntimes: ["pi"], trustedNetworks: [], getPermittedRoots, getAllowedOrigins: () => [] });
    expect(gate(claims)).toMatchObject({ allowed: false, reason: "operator-only" });
    expect(getPermittedRoots).not.toHaveBeenCalled();
  });
  it("missing boundary injection is deny, never a compatibility bypass", () => {
    expect(runSpawnGate(undefined, claims)).toMatchObject({ allowed: false, reason: "spawn-policy-unavailable" });
  });
  it("rechecks expiry of a principal captured by a long-lived browser socket in either posture", () => {
    const now = Date.now();
    const exp = Math.floor(now / 1000) + 10;
    const captured = { sub: "owner", username: "owner", name: "Owner", provider: "test", exp };
    const clock = vi.spyOn(Date, "now");
    try {
      for (const requireBrowserAuth of [false, true]) {
        const gate = createSpawnGate({ requireBrowserAuth, operatorUsers: ["owner"], expectedBridgeToken: token,
          requireBridgeToken: false, enabledRuntimes: ["pi"], trustedNetworks: [], getPermittedRoots: () => [cwd], getAllowedOrigins: () => [] });
        const request = { ...claims, channel: "browser-ws" as const, principal: captured, presentedBridgeToken: null };
        clock.mockReturnValue(now);
        expect(gate(request).allowed).toBe(true);
        clock.mockReturnValue((exp + 1) * 1000);
        expect(gate(request)).toMatchObject({ allowed: false, reason: "invalid-principal" });
      }
    } finally { clock.mockRestore(); }
  });
});
