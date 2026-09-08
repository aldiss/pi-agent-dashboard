import { describe, expect, it } from "vitest";
import { SESSION_WRITE_ACTION_CLASS } from "../session-authz.js";
import { deriveDelegatedBridgeOperator } from "../spawn-authz.js";

const LOOPBACK = {
  tokenVerified: true,
  remoteAddress: "127.0.0.1",
  forwarded: false,
  operatorUsers: ["aldiss"],
  localBridgeOperator: "aldiss",
  now: 1_700_000_000_000,
};

describe("delegated bridge authority is spawn and send_prompt only", () => {
  it("grants exactly two actions across the whole canonical action set", () => {
    const granted = Object.keys(SESSION_WRITE_ACTION_CLASS)
      .filter((action) => deriveDelegatedBridgeOperator({ ...LOOPBACK, action }).status === "delegated");

    expect(granted.sort()).toEqual(["send_prompt", "spawn"]);
  });

  it.each(["spawn", "send_prompt"])("keeps every precondition for %s", action => {
    for (const change of [
      { tokenVerified: false }, { remoteAddress: "10.1.2.3" }, { remoteAddress: "127.attacker.test" },
      { forwarded: true }, { localBridgeOperator: null }, { localBridgeOperator: "outsider" },
    ]) expect(deriveDelegatedBridgeOperator({ ...LOOPBACK, action, ...change }).status).not.toBe("delegated");
    expect(deriveDelegatedBridgeOperator({ ...LOOPBACK, action })).toMatchObject({
      status: "delegated", principal: { provider: "local-bridge-delegation", exp: 1_700_000_060 },
    });
  });

  it("refuses every explicitly denied verb and its protocol spelling", () => {
    for (const action of ["resume", "abort", "shutdown", "force_kill", "hide", "unhide", "model", "flow-control", "flow_control", "resurrect"]) {
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
