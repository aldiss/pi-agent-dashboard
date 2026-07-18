/**
 * Stage-6 E2E harness server for the "Needs you" band.
 *
 * A MINIMAL, self-contained server-under-test: it registers ONLY the real
 * `registerNeedsYouBandRoutes` (a permissive network guard) and proxies every
 * other request to a Vite dev server (which compiles the REAL `NeedsYouBand.tsx`
 * + the whole client on the fly). This exercises the exact route → component
 * path deterministically WITHOUT booting the heavy full dashboard server, and
 * WITHOUT touching the live :8000 or running `npm run build` (which would
 * clobber the auto-generated plugin-registry.tsx that another lane owns).
 *
 * Boots on the port in `NEEDS_YOU_E2E_PORT`; expects a Vite dev server already
 * listening on `NEEDS_YOU_E2E_VITE_PORT`. The route reads the synthetic feed via
 * the `NEEDS_YOU_*` env the harness sets (see needs-you-fixtures.ts).
 */
import Fastify from "fastify";
import { registerNeedsYouBandRoutes } from "../packages/server/src/routes/needs-you-band-routes.js";

const PORT = Number(process.env.NEEDS_YOU_E2E_PORT || 8137);
const VITE_PORT = Number(process.env.NEEDS_YOU_E2E_VITE_PORT || 5173);

async function main(): Promise<void> {
  const app = Fastify({ logger: false });

  // The real route — permissive guard (harness is loopback-only).
  registerNeedsYouBandRoutes(app, { networkGuard: async () => {} });

  // Health endpoint so the globalSetup can wait for readiness.
  app.get("/__e2e/health", async () => ({ ok: true }));

  // Everything else → proxy to the Vite dev server (the real client).
  app.setNotFoundHandler(async (request, reply) => {
    const viteUrl = `http://localhost:${VITE_PORT}${request.url}`;
    try {
      const res = await fetch(viteUrl, {
        method: request.method,
        headers: { accept: (request.headers["accept"] as string) ?? "*/*" },
      });
      const ct = res.headers.get("content-type");
      if (ct) reply.header("Content-Type", ct);
      reply.code(res.status);
      return reply.send(Buffer.from(await res.arrayBuffer()));
    } catch (err) {
      reply.code(502);
      return { success: false, error: `vite proxy failed: ${String(err)}` };
    }
  });

  await app.listen({ port: PORT, host: "127.0.0.1" });
  // eslint-disable-next-line no-console
  console.log(`[needs-you-e2e-harness] listening on http://127.0.0.1:${PORT} (vite :${VITE_PORT})`);
}

void main();
