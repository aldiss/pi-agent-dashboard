import { describe, expect, it } from "vitest";
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import type { AuthConfig } from "@blackbelt-technology/pi-dashboard-shared/config.js";
import type { TokenPayload } from "../auth.js";
import { createCellAccessController, createCellRegistrySnapshot } from "../cell-access.js";
import { authorizeSessionAction } from "../session-authz.js";
import { createOperatorSetTracker } from "../operator-set-tracker.js";

const OP = { sub: "op@example.com", username: "op", name: "Op", provider: "github", exp: 0 } as TokenPayload;
const GUEST = { sub: "guest@example.com", username: "guest", name: "Guest", provider: "github", exp: 0 } as TokenPayload;

function target(id: string, name: string): DashboardSession {
  return { id, name, cwd: "/repo", source: "tmux", status: "active", startedAt: 1 };
}

const config: AuthConfig = {
  secret: "test",
  providers: {},
  requireBrowserAuth: true,
  allowedUsers: ["op", "guest"],
  operatorUsers: ["op"],
  guestCellGrants: { guest: ["cell-a"] },
};
const snapshot = createCellRegistrySnapshot(
  {
    drivers: {
      A: { real_name: "A", cell: "cell-a", pid: 1 },
      B: { real_name: "B", cell: "cell-b", pid: 2 },
    },
  },
  [
    { name: "A", sessionId: "a", pid: 1 },
    { name: "B", sessionId: "b", pid: 2 },
  ],
);
const access = createCellAccessController({ authConfig: config, snapshot });
const A = target("a", "A");
const B = target("b", "B");

describe("cell boundary composes before D admission/action authorization", () => {
  it("allows guest co-drive inside grant and refuses outside/nonexistent identically before slot mutation", () => {
    const operatorSet = createOperatorSetTracker();
    const inside = authorizeSessionAction({
      actor: { kind: "human", principal: GUEST },
      action: "send_prompt",
      requireBrowserAuth: true,
      operatorUsers: config.operatorUsers,
      sessionId: A.id,
      session: A,
      operatorSet,
      cellAccess: access,
    });
    expect(inside.allowed).toBe(true);
    expect(operatorSet.count(A.id)).toBe(1);

    const outside = authorizeSessionAction({
      actor: { kind: "human", principal: GUEST },
      action: "abort",
      requireBrowserAuth: true,
      operatorUsers: config.operatorUsers,
      sessionId: B.id,
      session: B,
      operatorSet,
      cellAccess: access,
    });
    const missing = authorizeSessionAction({
      actor: { kind: "human", principal: GUEST },
      action: "abort",
      requireBrowserAuth: true,
      operatorUsers: config.operatorUsers,
      sessionId: "missing",
      session: undefined,
      operatorSet,
      cellAccess: access,
    });
    expect(outside).toEqual({ allowed: false, reason: "session-unavailable" });
    expect(missing).toEqual(outside);
    expect(operatorSet.count(B.id)).toBe(0);
    expect(operatorSet.count("missing")).toBe(0);
  });

  it("operator remains dashboard-wide; service actor remains outside guest grants", () => {
    const operatorSet = createOperatorSetTracker();
    expect(authorizeSessionAction({
      actor: { kind: "human", principal: OP },
      action: "shutdown",
      requireBrowserAuth: true,
      operatorUsers: config.operatorUsers,
      sessionId: B.id,
      session: B,
      operatorSet,
      cellAccess: access,
    }).allowed).toBe(true);

    expect(authorizeSessionAction({
      actor: { kind: "service", id: "background" },
      action: "send_prompt",
      requireBrowserAuth: true,
      operatorUsers: config.operatorUsers,
      sessionId: B.id,
      session: B,
      operatorSet,
      cellAccess: access,
    }).allowed).toBe(true);
  });

  it("guest grant never upgrades existing operator-only actions", () => {
    const decision = authorizeSessionAction({
      actor: { kind: "human", principal: GUEST },
      action: "shutdown",
      requireBrowserAuth: true,
      operatorUsers: config.operatorUsers,
      sessionId: A.id,
      session: A,
      operatorSet: createOperatorSetTracker(),
      cellAccess: access,
    });
    expect(decision).toEqual({ allowed: false, reason: "operator-only" });
  });
});
