import { describe, expect, it } from "vitest";
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import type { AuthConfig } from "@blackbelt-technology/pi-dashboard-shared/config.js";
import { createCellAccessController, createCellRegistrySnapshot } from "../cell-access.js";
import { authorizeGuestBrowserMessage } from "../cell-access-ws.js";

// Fix e101284: a send_prompt refused at the browser-gateway cell-boundary must
// surface a typed send_prompt_failed{reason} instead of a silent drop. This test
// pins the boundary DECISION that drives the emit: a principal-less send_prompt is
// refused with reason "no-principal" (the reason the server now forwards to the
// client, which re-auths on it — see the client-side twin test).
const config: AuthConfig = {
  secret: "test",
  providers: {},
  requireBrowserAuth: true,
  allowedUsers: ["op", "guest"],
  operatorUsers: ["op"],
  guestCellGrants: { guest: ["cell-a"] },
};
const snapshot = createCellRegistrySnapshot(
  { drivers: { A: { real_name: "A", cell: "cell-a", pid: 1 } } },
  [{ name: "A", sessionId: "a", pid: 1 }],
);
const access = createCellAccessController({ authConfig: config, snapshot });
const A: DashboardSession = { id: "a", name: "A", cwd: "/shared", source: "tmux", status: "active", startedAt: 1 };
const getSession = (id: string) => (id === "a" ? A : undefined);

describe("send_prompt boundary — no-principal reason (fix e101284 trigger)", () => {
  it("refuses a principal-less send_prompt with reason 'no-principal' (the emit driver)", () => {
    expect(
      authorizeGuestBrowserMessage(
        { type: "send_prompt", sessionId: "a", text: "hi" } as any,
        null,
        access,
        getSession,
      ),
    ).toEqual({ allowed: false, reason: "no-principal" });
  });
});
