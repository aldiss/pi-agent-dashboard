/**
 * createTestServer — boot a real DashboardServer on OS-assigned ports for
 * integration tests, with safe defaults (no auto-shutdown, no tunnel).
 *
 * Use with the `setup-home` vitest setupFile (in @blackbelt-technology/pi-dashboard-shared/test-support)
 * so that HOME is also isolated.
 *
 * Example:
 *   const { server, httpPort, piPort, stop } = await createTestServer();
 *   const res = await fetch(`http://localhost:${httpPort}/api/health`);
 *   ...
 *   await stop();
 */
import { createServer, type DashboardServer, type ServerConfig } from "../server.js";

export interface TestServerHandle {
  server: DashboardServer;
  httpPort: number;
  piPort: number;
  stop: () => Promise<void>;
}

export type TestServerOverrides = Partial<ServerConfig>;

const DEFAULTS: ServerConfig = {
  port: 0,
  piPort: 0,
  dev: true,
  autoShutdown: false,
  shutdownIdleSeconds: 999,
  tunnel: false,
  editor: { idleTimeoutMinutes: 10, maxInstances: 3 },
  // PUSHBACK-3 NIT (dual-review): fixtureMode disables mDNS-advertise (+ browser
  // open / zrok / bootstrap-install). Without it every createTestServer binds a
  // real mDNS responder on UDP:5353; under vitest file-parallelism the many
  // concurrent real servers CONTEND on that single well-known port → the benign
  // flag-OFF WS/inbox-timing flake the prior fixes documented (green in
  // isolation + sequential). Defaulting fixtureMode:true removes the contention
  // so the suite is stable under file-parallelism too. A test that needs a real
  // responder can still override `fixtureMode:false`.
  fixtureMode: true,
};

export async function createTestServer(
  overrides: TestServerOverrides = {},
): Promise<TestServerHandle> {
  const config: ServerConfig = { ...DEFAULTS, ...overrides };
  const server = await createServer(config);
  await server.start();

  const httpPort = server.httpPort();
  const piPort = server.piPort();
  if (httpPort == null || piPort == null) {
    await server.stop();
    throw new Error(
      `createTestServer: failed to resolve ports (httpPort=${httpPort}, piPort=${piPort})`,
    );
  }

  return {
    server,
    httpPort,
    piPort,
    stop: async () => {
      try {
        await server.stop();
      } catch {
        // best-effort — tests may race on shutdown
      }
    },
  };
}
