import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { makeRestPromptGate, makeRestSessionGate } from "../rest-session-gate.js";
import { SESSION_WRITE_ACTION_CLASS } from "../session-authz.js";

const token = "ab".repeat(32);

async function fixture(requireBrowserAuth = true) {
  const app = Fastify();
  const policy = { requireBrowserAuth, operatorUsers: ["owner"],
    bridgeDelegation: { expectedToken: token, localBridgeOperator: "owner" } };
  app.post("/api/session/:id/prompt", { preHandler: makeRestPromptGate(policy) }, async request => ({
    success: true, delegation: (request as any).restBridgeDelegation, principal: (request as any).restPrincipal ?? null,
  }));
  for (const action of Object.keys(SESSION_WRITE_ACTION_CLASS)) {
    if (action === "send_prompt") continue;
    app.post(`/api/session/:id/${action}`, { preHandler: makeRestSessionGate(policy)(action as any) }, async () => ({ success: true }));
  }
  return app;
}

describe("private loopback bridge REST send", () => {
  it("delegates send as service, never captures a human identity", async () => {
    const app = await fixture();
    try {
      const result = await app.inject({ method: "POST", url: "/api/session/target/prompt", remoteAddress: "127.0.0.1",
        headers: { "x-pi-bridge-token": token }, payload: { text: "hello", author: { sub: "owner" } } });
      expect(result.statusCode).toBe(200);
      expect(result.json()).toMatchObject({ principal: null, delegation: { provider: "local-bridge-delegation" } });
    } finally { await app.close(); }
  });

  it.each([true, false])("refuses every other verb with auth flag %s", async flag => {
    const app = await fixture(flag);
    try {
      for (const action of Object.keys(SESSION_WRITE_ACTION_CLASS).filter(action => action !== "send_prompt")) {
        const response = await app.inject({ method: "POST", url: `/api/session/target/${action}`, remoteAddress: "127.0.0.1",
          headers: { "x-pi-bridge-token": token }, payload: {} });
        expect(response.statusCode, action).toBe(403);
      }
      for (const text of ["/model fake", "/resume", "/quit", "!whoami", "/new codex"]) {
        const response = await app.inject({ method: "POST", url: "/api/session/target/prompt", remoteAddress: "127.0.0.1",
          headers: { "x-pi-bridge-token": token }, payload: { text } });
        expect(response.statusCode, text).toBe(403);
      }
    } finally { await app.close(); }
  });

  it.each([
    { remoteAddress: "127.0.0.1", headers: {} },
    { remoteAddress: "127.0.0.1", headers: { "x-pi-bridge-token": "wrong" } },
    { remoteAddress: "192.0.2.1", headers: { "x-pi-bridge-token": token } },
    ...["forwarded", "x-forwarded-for", "x-forwarded-host", "x-real-ip"].map(header => ({ remoteAddress: "127.0.0.1", headers: { "x-pi-bridge-token": token, [header]: "127.0.0.1" } })),
  ])("rejects hostile transport %#", async transport => {
    const app = await fixture();
    try {
      const result = await app.inject({ method: "POST", url: "/api/session/target/prompt", ...transport, payload: { text: "hello" } });
      expect([401, 403]).toContain(result.statusCode);
    } finally { await app.close(); }
  });
});
