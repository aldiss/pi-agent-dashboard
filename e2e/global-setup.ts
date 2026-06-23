import { request } from "@playwright/test";

const BASE_URL = process.env.PI_DASHBOARD_BASE_URL || "http://127.0.0.1:8000";

/**
 * Verify the live dashboard is reachable + identity-healthy before the suite
 * runs. v1 runs against the live :8000 instance (see playwright.config.ts for
 * why we don't boot our own). A fast, explicit failure here beats 30+ opaque
 * per-spec navigation timeouts when the server is simply down.
 */
export default async function globalSetup() {
  const ctx = await request.newContext();
  try {
    const res = await ctx.get(`${BASE_URL}/api/health`, { timeout: 8_000 });
    if (!res.ok()) {
      throw new Error(`health check returned HTTP ${res.status()}`);
    }
    const body = await res.json();
    if (!body?.ok) {
      throw new Error(`health payload not ok: ${JSON.stringify(body).slice(0, 200)}`);
    }
    // eslint-disable-next-line no-console
    console.log(
      `[e2e] live dashboard healthy at ${BASE_URL} ` +
        `(mode=${body.mode}, sessions=${body.server?.totalSessions ?? "?"})`,
    );
  } catch (err) {
    throw new Error(
      `[e2e] dashboard not reachable at ${BASE_URL}.\n` +
        `      v1 runs against the live server — start it with \`pi-dashboard start\` ` +
        `(or point PI_DASHBOARD_BASE_URL at a running instance).\n` +
        `      Underlying error: ${(err as Error).message}`,
    );
  } finally {
    await ctx.dispose();
  }
}
