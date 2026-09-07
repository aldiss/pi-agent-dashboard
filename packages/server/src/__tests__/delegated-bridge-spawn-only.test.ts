import { describe, expect, it } from "vitest";
import { SESSION_WRITE_ACTION_CLASS } from "../session-authz.js";
import { deriveDelegatedBridgeOperator } from "../spawn-authz.js";

/**
 * Delegation stays SPAWN-ONLY after the codex-runtime change.
 *
 * The bridge gained the ability to REQUEST a runtime; it gained no new
 * authority. `deriveDelegatedBridgeOperator` refuses every action except
 * `spawn`, so a delegated loopback bridge can create a session but can never
 * drive, stop, or reconfigure one.
 *
 * The sweep is driven off `SESSION_WRITE_ACTION_CLASS` rather than a
 * hand-written list so a future action is covered the day it is added — the
 * same close-by-construction discipline the shared prompt parser uses.
 */

const LOOPBACK = {
  tokenVerified: true,
  remoteAddress: "127.0.0.1",
  forwarded: false,
  operatorUsers: ["aldiss"],
  localBridgeOperator: "aldiss",
  now: 1_700_000_000_000,
};

describe("ACCEPTANCE 3 — delegated bridge authority is spawn-only", () => {
  it("grants exactly one action across the whole canonical action set", () => {
    const granted = Object.keys(SESSION_WRITE_ACTION_CLASS)
      .filter((action) => deriveDelegatedBridgeOperator({ ...LOOPBACK, action }).status === "delegated");

    expect(granted).toEqual(["spawn"]);
  });

  it("refuses the five actions named in the build brief with `not-spawn`", () => {
    for (const action of ["resume", "abort", "shutdown", "model", "flow-control"]) {
      expect(deriveDelegatedBridgeOperator({ ...LOOPBACK, action }))
        .toEqual({ status: "refused", why: "not-spawn" });
    }
  });

  it("still grants spawn itself, so the sweep above is not vacuous", () => {
    const decision = deriveDelegatedBridgeOperator({ ...LOOPBACK, action: "spawn" });
    expect(decision.status).toBe("delegated");
    expect(decision).toMatchObject({ principal: { sub: "aldiss", provider: "local-bridge-delegation" } });
  });

  it("keeps the loopback / token / delegate-disabled conditions binding on spawn", () => {
    expect(deriveDelegatedBridgeOperator({ ...LOOPBACK, action: "spawn", tokenVerified: false }))
      .toEqual({ status: "refused", why: "no-token" });
    expect(deriveDelegatedBridgeOperator({ ...LOOPBACK, action: "spawn", remoteAddress: "10.1.2.3" }))
      .toEqual({ status: "refused", why: "remote" });
    expect(deriveDelegatedBridgeOperator({ ...LOOPBACK, action: "spawn", forwarded: true }))
      .toEqual({ status: "refused", why: "remote" });
    expect(deriveDelegatedBridgeOperator({ ...LOOPBACK, action: "spawn", localBridgeOperator: null }))
      .toEqual({ status: "disabled" });
  });
});
