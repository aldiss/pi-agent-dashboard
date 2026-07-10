import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DashboardEvent, DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import type { AuthConfig } from "@blackbelt-technology/pi-dashboard-shared/config.js";
import { createCellAccessController, createCellRegistrySnapshot } from "../cell-access.js";
import { createPushTokenRegistry } from "../push/push-token-registry.js";
import { createPushDispatcher } from "../push/push-dispatcher.js";
import type { PushPrincipal, PushToken } from "../push/push-types.js";
import type { PushTransport } from "../push/push-transports/types.js";

const OP: PushPrincipal = { provider: "github", sub: "op@example.com", username: "op" };
const GUEST: PushPrincipal = { provider: "github", sub: "guest@example.com", username: "guest" };
const OUTSIDER: PushPrincipal = { provider: "github", sub: "other@example.com", username: "other" };
const auth: AuthConfig = {
  secret: "test",
  providers: {},
  requireBrowserAuth: true,
  allowedUsers: ["op", "guest"],
  operatorUsers: ["op"],
  guestCellGrants: { guest: ["cell-a"] },
};
const registrySnapshot = createCellRegistrySnapshot(
  { drivers: {
    A: { real_name: "A", cell: "cell-a", pid: 1 },
    B: { real_name: "B", cell: "cell-b", pid: 2 },
  } },
  [
    { name: "A", sessionId: "a", pid: 1 },
    { name: "B", sessionId: "b", pid: 2 },
  ],
);
const access = createCellAccessController({ authConfig: auth, snapshot: registrySnapshot });
const sessions = new Map<string, DashboardSession>([
  ["a", { id: "a", name: "A", cwd: "/a", source: "tmux", status: "active", startedAt: 1 }],
  ["b", { id: "b", name: "B", cwd: "/b", source: "tmux", status: "active", startedAt: 1 }],
]);

function sub(endpoint: string) {
  return { endpoint, keys: { p256dh: "p", auth: "a" } };
}
function asTokenPrincipal(owner: PushPrincipal) {
  return { ...owner, name: owner.username, exp: 0 } as any;
}
function event(): DashboardEvent {
  return { eventType: "agent_end", timestamp: Date.now(), data: {} } as DashboardEvent;
}

describe("push token principal ownership and cell-scoped fanout", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("persists verified owner and treats unowned legacy token as quarantined", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cell-push-reg-"));
    dirs.push(dir);
    const registry = createPushTokenRegistry({ path: path.join(dir, "tokens.json") });
    const owned = registry.add({ deviceToken: sub("https://push.example/op"), transport: "web-push", owner: OP });
    const legacy = registry.add({ deviceToken: sub("https://push.example/legacy"), transport: "web-push" });
    expect(registry.list().find((t) => t.id === owned)?.owner).toEqual(OP);
    expect(registry.list().find((t) => t.id === legacy)?.owner).toBeUndefined();
  });

  it("operator receives both cells, guest only granted cell, outsider and legacy receive none", async () => {
    const sent: Array<{ endpoint: string; sessionId: string }> = [];
    const transport: PushTransport = {
      kind: "web-push",
      async send(token, payload) {
        sent.push({ endpoint: token.deviceToken.endpoint, sessionId: payload.sessionId });
        return { ok: true };
      },
    };
    const tokens: PushToken[] = [
      { id: "op", deviceToken: sub("https://push.example/op"), transport: "web-push", owner: OP, registeredAt: "x", lastUsedAt: "x" },
      { id: "guest", deviceToken: sub("https://push.example/guest"), transport: "web-push", owner: GUEST, registeredAt: "x", lastUsedAt: "x" },
      { id: "other", deviceToken: sub("https://push.example/other"), transport: "web-push", owner: OUTSIDER, registeredAt: "x", lastUsedAt: "x" },
      { id: "legacy", deviceToken: sub("https://push.example/legacy"), transport: "web-push", registeredAt: "x", lastUsedAt: "x" },
    ];
    const tokenRegistry = {
      list: () => tokens,
      remove: () => false,
      touch: () => {},
    } as any;
    const dispatcher = createPushDispatcher({
      transports: new Map([["web-push", transport]]),
      registry: tokenRegistry,
      coalesceWindowMs: 0,
      canDeliver(token, sessionId) {
        if (!token.owner) return false;
        const principal = asTokenPrincipal(token.owner);
        return access.isPrincipalAdmitted(principal)
          && access.canViewSession(principal, sessions.get(sessionId));
      },
    });

    dispatcher.fanout("a", sessions.get("a"), event());
    dispatcher.fanout("b", sessions.get("b"), event());
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(sent).toEqual(expect.arrayContaining([
      { endpoint: "https://push.example/op", sessionId: "a" },
      { endpoint: "https://push.example/op", sessionId: "b" },
      { endpoint: "https://push.example/guest", sessionId: "a" },
    ]));
    expect(sent).toHaveLength(3);
  });
});
