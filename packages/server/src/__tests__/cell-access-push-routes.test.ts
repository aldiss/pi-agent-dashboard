import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AuthConfig } from "@blackbelt-technology/pi-dashboard-shared/config.js";
import { createCellAccessController, createCellRegistrySnapshot } from "../cell-access.js";
import { createPushTokenRegistry } from "../push/push-token-registry.js";
import { registerPushRoutes } from "../routes/push-routes.js";

const auth: AuthConfig = {
  secret: "test",
  providers: {},
  requireBrowserAuth: true,
  allowedUsers: ["op", "guest"],
  operatorUsers: ["op"],
  guestCellGrants: { guest: ["cell-a"] },
};
const access = createCellAccessController({
  authConfig: auth,
  snapshot: createCellRegistrySnapshot({ drivers: {} }, []),
});
const p256dh = Buffer.alloc(65, 1).toString("base64url");
const authKey = Buffer.alloc(16, 2).toString("base64url");

describe("push REST principal ownership", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("guest manages only own token; manual send stays operator-only", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "push-routes-cell-"));
    dirs.push(dir);
    const tokenRegistry = createPushTokenRegistry({ path: path.join(dir, "tokens.json") });
    const sendNow = vi.fn(async (_payload, opts) =>
      (opts?.tokenIds ?? tokenRegistry.list().map((token) => token.id)).map((id: string) => ({ tokenId: id, ok: true })),
    );
    const app = Fastify();
    app.decorateRequest("restPrincipal", null);
    app.decorateRequest("restActorKind", null);
    app.addHook("onRequest", async (request) => {
      const who = request.headers["x-test-user"];
      if (who === "guest" || who === "op") {
        (request as any).restActorKind = "human";
        (request as any).restPrincipal = {
          sub: `${who}@example.com`,
          username: who,
          name: who,
          provider: "github",
          exp: 0,
        };
      }
    });
    registerPushRoutes(app, {
      tokenRegistry,
      dispatcher: { sendNow, fanout() {} },
      vapidKeys: { publicKey: "pub", privateKey: "priv" },
      cellAccess: access,
    });
    await app.ready();

    async function register(who: "guest" | "op", endpoint: string) {
      const response = await app.inject({
        method: "POST",
        url: "/api/push/register",
        headers: { "x-test-user": who },
        payload: { deviceToken: { endpoint, keys: { p256dh, auth: authKey } }, transport: "web-push" },
      });
      expect(response.statusCode).toBe(200);
      return response.json().tokenId as string;
    }

    const guestId = await register("guest", "https://push.example/guest-1");
    const opId = await register("op", "https://push.example/op-1");
    expect(tokenRegistry.list().find((t) => t.id === guestId)?.owner?.username).toBe("guest");
    expect(tokenRegistry.list().find((t) => t.id === opId)?.owner?.username).toBe("op");

    const guestList = await app.inject({ method: "GET", url: "/api/push/tokens", headers: { "x-test-user": "guest" } });
    expect(guestList.json().tokens.map((t: any) => t.id)).toEqual([guestId]);

    const crossDelete = await app.inject({ method: "DELETE", url: `/api/push/register/${opId}`, headers: { "x-test-user": "guest" } });
    expect(crossDelete.statusCode).toBe(404);
    expect(tokenRegistry.list().some((t) => t.id === opId)).toBe(true);

    sendNow.mockClear();
    const crossTest = await app.inject({ method: "POST", url: "/api/push/test", headers: { "x-test-user": "guest" }, payload: { tokenId: opId } });
    expect(crossTest.statusCode).toBe(200);
    expect(sendNow.mock.calls[0][1]).toEqual({ tokenIds: [] });

    const guestSend = await app.inject({ method: "POST", url: "/api/push/send", headers: { "x-test-user": "guest" }, payload: { title: "x", body: "y" } });
    expect(guestSend.statusCode).toBe(403);

    const opSend = await app.inject({ method: "POST", url: "/api/push/send", headers: { "x-test-user": "op" }, payload: { title: "x", body: "y" } });
    expect(opSend.statusCode).toBe(200);
    await app.close();
  });
});
