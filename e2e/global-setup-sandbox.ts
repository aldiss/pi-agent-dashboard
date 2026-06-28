import { request } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Seeded sandbox globalSetup — boots a HOME-jailed, fixture-mode dashboard on an
 * alt port seeded from `seed/`, so the session-list specs run against a
 * DETERMINISTIC row-set (the live :8000 suite can't snapshot the session list
 * because names/status/costs change run-to-run — see e2e/README.md "Visual
 * regression"). This is the flagged follow-up that finally unlocks session-list
 * snapshots, and it is design-pass §3's "deploy a dashboard change → assert the
 * rows render right" substrate.
 *
 * Isolation is owned by the `e2e-sandbox` CLI (nos-real-e2e-test-infrastructure
 * /v1 W3): throwaway $HOME, fixture dashboard (no mDNS-advertise / zrok /
 * browser, federation OFF), tmux -L pi-test, bridge pin. This setup is a thin
 * wrapper: `e2e-sandbox up` → health-gate → return a teardown that runs
 * `e2e-sandbox down` (which asserts live :8000 / -L pi unchanged).
 *
 * The base URL the specs use is http://127.0.0.1:8100 (the sandbox falls back to
 * 127.0.0.1 when the distinct loopback host 127.0.0.2 is not bindable — macOS
 * without a sudo lo0 alias). Override the sandbox port with E2E_SBX_PORT.
 */

const SBX_PORT = process.env.E2E_SBX_PORT || "8100";
const BASE_URL = process.env.PI_DASHBOARD_BASE_URL || `http://127.0.0.1:${SBX_PORT}`;

/** Locate the `e2e-sandbox` CLI. Default: the pi-config build worktree, then a
 *  couple of sensible fallbacks. Override with E2E_SANDBOX_BIN. */
function resolveSandboxBin(): string {
  const explicit = process.env.E2E_SANDBOX_BIN;
  if (explicit && existsSync(explicit)) return explicit;
  const candidates = [
    join(homedir(), "Misc/Documents/Copilot/pi-config-e2e-wt/pi/bin/e2e-sandbox"),
    join(homedir(), "Misc/Documents/Copilot/pi-config/pi/bin/e2e-sandbox"),
    join(homedir(), "bin/e2e-sandbox"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(
    `[e2e-sandbox] CLI not found. Set E2E_SANDBOX_BIN to the e2e-sandbox path. Tried:\n  ${candidates.join("\n  ")}`,
  );
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const bin = resolveSandboxBin();

  // If a sandbox is already healthy on the port, reuse it (a developer may have
  // stood one up by hand). Otherwise boot one.
  const ctx0 = await request.newContext();
  let alreadyUp = false;
  try {
    const res = await ctx0.get(`${BASE_URL}/api/health`, { timeout: 2_000 });
    alreadyUp = res.ok();
  } catch {
    /* not up — we boot it */
  } finally {
    await ctx0.dispose();
  }

  if (!alreadyUp) {
    // eslint-disable-next-line no-console
    console.log(`[e2e-sandbox] booting seeded fixture dashboard via ${bin} up …`);
    const up = spawnSync(bin, ["up"], {
      encoding: "utf-8",
      // active-project gives a small, deterministic row-set the specs assert on.
      env: { ...process.env, E2E_SEED_FIXTURES: process.env.E2E_SEED_FIXTURES || "active-project" },
      timeout: 90_000,
    });
    if (up.status !== 0) {
      throw new Error(
        `[e2e-sandbox] \`e2e-sandbox up\` failed (exit ${up.status}).\n` +
          `stdout:\n${up.stdout}\nstderr:\n${up.stderr}`,
      );
    }
    // eslint-disable-next-line no-console
    console.log(up.stdout?.split("\n").filter((l) => /UP|PASS|healthy/.test(l)).join("\n"));
  } else {
    // eslint-disable-next-line no-console
    console.log(`[e2e-sandbox] reusing the sandbox already healthy at ${BASE_URL}`);
  }

  // Health-gate (same contract as the live global-setup.ts).
  const ctx = await request.newContext();
  try {
    const res = await ctx.get(`${BASE_URL}/api/health`, { timeout: 8_000 });
    if (!res.ok()) throw new Error(`health check returned HTTP ${res.status()}`);
    const body = await res.json();
    if (!body?.ok) throw new Error(`health payload not ok: ${JSON.stringify(body).slice(0, 200)}`);
    // eslint-disable-next-line no-console
    console.log(
      `[e2e-sandbox] seeded dashboard healthy at ${BASE_URL} ` +
        `(mode=${body.mode}, sessions=${body.server?.totalSessions ?? "?"})`,
    );
  } catch (err) {
    throw new Error(`[e2e-sandbox] sandbox not reachable at ${BASE_URL}: ${(err as Error).message}`);
  } finally {
    await ctx.dispose();
  }

  // Teardown — only tear down what THIS setup booted. If we reused a hand-started
  // sandbox, leave it running for the developer.
  return async () => {
    if (alreadyUp) {
      // eslint-disable-next-line no-console
      console.log(`[e2e-sandbox] leaving the pre-existing sandbox up (we did not boot it)`);
      return;
    }
    // eslint-disable-next-line no-console
    console.log(`[e2e-sandbox] tearing down via ${bin} down …`);
    const down = spawnSync(bin, ["down"], { encoding: "utf-8", timeout: 30_000 });
    // eslint-disable-next-line no-console
    console.log(down.stdout?.split("\n").filter((l) => /DOWN|unchanged|WARNING/.test(l)).join("\n"));
  };
}
