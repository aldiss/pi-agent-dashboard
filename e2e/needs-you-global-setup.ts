/**
 * Stage-6 E2E globalSetup for the "Needs you" band.
 *
 * Boots a SELF-CONTAINED server-under-test (NOT the shared live :8000):
 *   1. Snapshots the auto-generated `plugin-registry.tsx` (Vite dev regenerates
 *      it on boot; another lane owns its current content) → restored on teardown.
 *   2. Spawns an isolated Vite dev server on NEEDS_YOU_E2E_VITE_PORT (compiles
 *      the real client incl. NeedsYouBand.tsx).
 *   3. Spawns the minimal harness server (needs-you-harness-server.ts) on
 *      NEEDS_YOU_E2E_PORT: real needs-you route + Vite proxy.
 *   4. Seeds a fresh heartbeat + an empty feed so the first paint is deterministic.
 *
 * Returns a teardown that kills both processes + restores the generated file, so
 * the tree is left EXACTLY as found (non-destructive; never touches :8000/:3000).
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureFixturesDir, writeFeed, writeFreshHeartbeat, clearReceipts, productionHeld, fixtureEnv } from "./needs-you-fixtures.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const GENERATED = path.join(REPO, "packages/client/src/generated/plugin-registry.tsx");

const HTTP_PORT = Number(process.env.NEEDS_YOU_E2E_PORT || 8137);
const VITE_PORT = Number(process.env.NEEDS_YOU_E2E_VITE_PORT || 5173);

/** Resolve the jiti loader URL (same mechanism as bin/pi-dashboard.mjs). */
function jitiLoader(): string {
  const reg = path.join(REPO, "node_modules/jiti/lib/jiti-register.mjs");
  return reg;
}

async function waitFor(url: string, label: string, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`[needs-you-e2e] ${label} not ready at ${url} after ${timeoutMs}ms`);
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  // 1. Snapshot the generated file (restore on teardown).
  const snapshot = fs.existsSync(GENERATED) ? fs.readFileSync(GENERATED, "utf-8") : null;

  ensureFixturesDir();
  clearReceipts();
  writeFreshHeartbeat();
  // Seed a default feed so the very first client fetch is deterministic (not
  // feed-missing). Specs overwrite it for their own scenario.
  writeFeed([productionHeld()]);

  // 2. Vite dev on the isolated port (strictPort so it never drifts onto :3000).
  const vite: ChildProcess = spawn(
    "node",
    [path.join(REPO, "node_modules/vite/bin/vite.js"), "--port", String(VITE_PORT), "--strictPort"],
    { cwd: path.join(REPO, "packages/client"), stdio: "ignore", env: { ...process.env } },
  );

  // 3. The harness server (real route + Vite proxy) via jiti.
  const server: ChildProcess = spawn(
    "node",
    ["--import", jitiLoader(), path.join(HERE, "needs-you-harness-server.ts")],
    {
      cwd: REPO,
      stdio: "ignore",
      env: {
        ...process.env,
        ...fixtureEnv(), // NEEDS_YOU_MUST_ACT_FILE/heartbeat/receipt → our synthetic fixtures
        NEEDS_YOU_E2E_PORT: String(HTTP_PORT),
        NEEDS_YOU_E2E_VITE_PORT: String(VITE_PORT),
      },
    },
  );

  try {
    await waitFor(`http://localhost:${VITE_PORT}/`, "vite");
    await waitFor(`http://127.0.0.1:${HTTP_PORT}/__e2e/health`, "harness server");
  } catch (err) {
    vite.kill("SIGKILL");
    server.kill("SIGKILL");
    if (snapshot !== null) fs.writeFileSync(GENERATED, snapshot);
    throw err;
  }

  // eslint-disable-next-line no-console
  console.log(`[needs-you-e2e] harness ready: http://127.0.0.1:${HTTP_PORT} (vite :${VITE_PORT})`);

  // Teardown — kill both, restore the generated file.
  return async () => {
    server.kill("SIGKILL");
    vite.kill("SIGKILL");
    if (snapshot !== null) {
      try { fs.writeFileSync(GENERATED, snapshot); } catch { /* best-effort */ }
    }
  };
}
