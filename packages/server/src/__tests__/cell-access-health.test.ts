import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AuthConfig } from "@blackbelt-technology/pi-dashboard-shared/config.js";
import { signToken, COOKIE_NAME } from "../auth.js";
import { createTestServer, type TestServerHandle } from "../test-support/test-server.js";

/**
 * Own the HOME this file writes under, before ANY `.pi` path is computed.
 *
 * Several modules in the server's import graph freeze a `~/.pi` path into a
 * module-level const at import time (`shared/config.ts` CONFIG_DIR/CONFIG_FILE,
 * `driver-registry.ts` DRIVER_REGISTRY_PATH, `preferences-store.ts`
 * PREFERENCES_FILE). ESM evaluates every import BEFORE the module body, so a
 * plain top-level assignment here would land too late and those consts would
 * capture the ambient home. `vi.hoisted` is lifted above the imports, so the
 * redirect happens first.
 *
 * The block is deliberately SYNCHRONOUS: an async hoisted callback is not
 * awaited before the import graph evaluates, so any `await` inside it loses the
 * race and the frozen consts capture the ambient home instead. `fs` is reached
 * via `process.getBuiltinModule` (Node 22.3+) because neither `import` nor
 * `require` is available synchronously at hoist time.
 *
 * This is self-contained on purpose: it must hold even under a custom or
 * mis-scoped Vitest config that omits the repository's global HOME guard.
 */
const testHome = vi.hoisted(() => {
  const nodeFs = process.getBuiltinModule("node:fs");
  const nodeOs = process.getBuiltinModule("node:os");
  const nodePath = process.getBuiltinModule("node:path");
  const previousHome = process.env.HOME;
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "pi-cell-health-"));
  process.env.HOME = root;
  return { previousHome, root };
});

afterAll(() => {
  if (testHome.previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = testHome.previousHome;
  // Only ever the tree this file created under tmpdir.
  fs.rmSync(testHome.root, { recursive: true, force: true });
});

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
    const home = testHome.root;
    // Fail loudly rather than write outside the test-owned tree if the redirect
    // above ever stops taking effect.
    expect(home.startsWith(os.tmpdir())).toBe(true);
    expect(home).not.toBe(os.userInfo().homedir);
    expect(process.env.HOME).toBe(home);
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
      expect(JSON.stringify(limited)).not.toContain(home);
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
