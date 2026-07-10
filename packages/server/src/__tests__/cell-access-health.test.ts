import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { AuthConfig } from "@blackbelt-technology/pi-dashboard-shared/config.js";
import { signToken, COOKIE_NAME } from "../auth.js";
import { createTestServer, type TestServerHandle } from "../test-support/test-server.js";

const SECRET = "cell-health-test-secret";
const authConfig: AuthConfig = {
  secret: SECRET,
  providers: {},
  requireBrowserAuth: true,
  allowedUsers: ["op", "guest"],
  operatorUsers: ["op"],
  guestCellGrants: { guest: ["cell-a"] },
};
const publicKeys = ["commit", "gatewayListening", "mode", "ok", "uptime", "version"];

describe("cell boundary health caller matrix", () => {
  let handle: TestServerHandle | undefined;
  afterEach(async () => {
    if (handle) await handle.stop();
    handle = undefined;
  });

  it("remote anonymous/guest/trusted-network get exact liveness; operator/local/service retain full", async () => {
    const home = process.env.HOME!;
    const cellPath = path.join(home, ".pi", "orchestration-state", "cell-driver-registry.json");
    const messengerDir = path.join(home, ".pi", "agent", "messenger", "registry");
    fs.mkdirSync(path.dirname(cellPath), { recursive: true });
    fs.mkdirSync(messengerDir, { recursive: true });
    fs.writeFileSync(cellPath, JSON.stringify({ drivers: {} }));

    handle = await createTestServer({
      authConfig,
      resolvedTrustedNetworks: ["100.64.0.0/10"],
    });
    const base = `http://127.0.0.1:${handle.httpPort}`;
    const guestToken = signToken({ sub: "guest@example.com", username: "guest", name: "Guest", provider: "github" }, SECRET);
    const opToken = signToken({ sub: "op@example.com", username: "op", name: "Op", provider: "github" }, SECRET);

    async function health(headers: Record<string, string> = {}) {
      const res = await fetch(`${base}/api/health`, { headers });
      expect(res.status).toBe(200);
      return res.json() as Promise<Record<string, unknown>>;
    }

    const remoteAnon = await health({ "X-Forwarded-For": "203.0.113.10" });
    const remoteTrustedNoCookie = await health({ "X-Forwarded-For": "100.64.0.10" });
    const remoteGuest = await health({
      "X-Forwarded-For": "203.0.113.11",
      Cookie: `${COOKIE_NAME}=${guestToken}`,
    });
    for (const limited of [remoteAnon, remoteTrustedNoCookie, remoteGuest]) {
      expect(Object.keys(limited).sort()).toEqual(publicKeys);
      expect(limited).not.toHaveProperty("agents");
      expect(limited).not.toHaveProperty("server");
      expect(JSON.stringify(limited)).not.toContain(process.env.HOME!);
    }

    const remoteOp = await health({
      "X-Forwarded-For": "203.0.113.12",
      Cookie: `${COOKIE_NAME}=${opToken}`,
    });
    const local = await health();
    const service = await health({
      "X-Forwarded-For": "203.0.113.13",
      Authorization: `Bearer ${SECRET}`,
    });
    for (const full of [remoteOp, local, service]) {
      expect(full).toHaveProperty("agents");
      expect(full).toHaveProperty("server.totalSessions");
      expect(full).toHaveProperty("starter");
      expect(full).toHaveProperty("pid");
    }
  }, 20_000);
});
