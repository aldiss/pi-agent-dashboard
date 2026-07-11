/**
 * C5 — huddle private-audience egress quarantine (M-D).
 *
 * Proves the load-bearing M-D guarantee: a `huddle_turn` (and the private block
 * notice `huddle_catchup_blocked`) is delivered ONLY to a principal whose `sub`
 * is in `operatorSet.operatorsOf(sessionId)` — NOT by `canViewSession`, NOT by
 * the dashboard-wide operator role. Closes the M3 leak: a 3rd cell viewer (even
 * an operator) never sees the private huddle exchange.
 */
import { describe, it, expect } from "vitest";
import { filterServerMessageForPrincipal } from "../cell-access-ws.js";
import { createOperatorSetTracker } from "../operator-set-tracker.js";
import type { CellAccessController } from "../cell-access.js";
import type { TokenPayload } from "../auth.js";
import type { ServerToBrowserMessage } from "@blackbelt-technology/pi-dashboard-shared/browser-protocol.js";

const SESSION = "sess-1";

function principal(sub: string): TokenPayload {
  return { sub, name: sub, username: sub, provider: "github", exp: 0 } as TokenPayload;
}

/**
 * A minimal cell-access stub. `roleForPrincipal` returns operator for subs in
 * `operators`, else guest; everyone admitted; canViewSession always true (the
 * point: viewing is NOT sufficient for a huddle_turn).
 */
function cellAccess(operators: Set<string>): CellAccessController {
  return {
    enabled: true,
    isPrincipalAdmitted: () => true,
    roleForPrincipal: (p: TokenPayload | null) => (p && operators.has(p.sub) ? "operator" : "guest"),
    canViewSession: () => true,
    filterSessions: (_p: unknown, s: unknown) => s,
  } as unknown as CellAccessController;
}

function huddleTurn(sessionId = SESSION): ServerToBrowserMessage {
  return {
    type: "huddle_turn",
    sessionId,
    seq: 0,
    epoch: 1,
    author: { sub: "op1@e.com", display: "Op One", isOperator: true },
    role: "operator",
    text: "private conferral",
    recordedAt: 1000,
  } as ServerToBrowserMessage;
}

describe("C5 egress — huddle_turn gated by operatorsOf, not view/role", () => {
  it("delivers to an admitted co-driver (member of operatorsOf)", () => {
    const ops = createOperatorSetTracker();
    ops.commit(SESSION, "op1@e.com");
    ops.commit(SESSION, "op2@e.com");
    const ca = cellAccess(new Set(["op1@e.com"])); // op1 has operator role
    const out = filterServerMessageForPrincipal(
      huddleTurn(), principal("op2@e.com"), ca, () => undefined, new Set(), "core", ops,
    );
    expect(out).not.toBeNull();
    expect((out as any).type).toBe("huddle_turn");
  });

  it("REFUSES a 3rd cell viewer who is NOT an admitted co-driver (M3 leak closed)", () => {
    const ops = createOperatorSetTracker();
    ops.commit(SESSION, "op1@e.com");
    ops.commit(SESSION, "op2@e.com");
    const ca = cellAccess(new Set()); // viewer is a guest
    // op3 can VIEW the cell (canViewSession true) but is not in operatorsOf.
    const out = filterServerMessageForPrincipal(
      huddleTurn(), principal("op3@e.com"), ca, () => undefined, new Set(), "core", ops,
    );
    expect(out).toBeNull();
  });

  it("REFUSES even a dashboard-wide OPERATOR who is not admitted to THIS session", () => {
    const ops = createOperatorSetTracker();
    ops.commit(SESSION, "op1@e.com");
    ops.commit(SESSION, "op2@e.com");
    // op3 holds the operator role dashboard-wide, but is NOT a co-driver here.
    const ca = cellAccess(new Set(["op3@e.com"]));
    const out = filterServerMessageForPrincipal(
      huddleTurn(), principal("op3@e.com"), ca, () => undefined, new Set(), "core", ops,
    );
    expect(out).toBeNull(); // role does not override the operatorsOf gate
  });

  it("fails closed when operatorSet is absent (no leak on a mis-wired server)", () => {
    const ca = cellAccess(new Set(["op1@e.com"]));
    const out = filterServerMessageForPrincipal(
      huddleTurn(), principal("op1@e.com"), ca, () => undefined, new Set(), "core", undefined,
    );
    expect(out).toBeNull();
  });

  it("refuses a plugin-origin carrier spoofing huddle_turn", () => {
    const ops = createOperatorSetTracker();
    ops.commit(SESSION, "op1@e.com");
    const ca = cellAccess(new Set(["op1@e.com"]));
    const out = filterServerMessageForPrincipal(
      huddleTurn(), principal("op1@e.com"), ca, () => undefined, new Set(), "plugin", ops,
    );
    expect(out).toBeNull();
  });

  it("gates the private block notice huddle_catchup_blocked the same way", () => {
    const ops = createOperatorSetTracker();
    ops.commit(SESSION, "op1@e.com");
    const ca = cellAccess(new Set());
    const notice = { type: "huddle_catchup_blocked", sessionId: SESSION } as unknown as ServerToBrowserMessage;
    // Non-member refused…
    expect(
      filterServerMessageForPrincipal(notice, principal("op3@e.com"), ca, () => undefined, new Set(), "core", ops),
    ).toBeNull();
    // …member allowed.
    expect(
      filterServerMessageForPrincipal(notice, principal("op1@e.com"), ca, () => undefined, new Set(), "core", ops),
    ).not.toBeNull();
  });
});
