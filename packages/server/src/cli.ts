#!/usr/bin/env node
/**
 * PI Dashboard Server CLI
 *
 * Usage:
 *   pi-dashboard                    Start server in foreground (default)
 *   pi-dashboard start [flags]      Start server as background daemon
 *   pi-dashboard stop               Stop running daemon
 *   pi-dashboard restart [flags]    Restart daemon
 *   pi-dashboard status             Show daemon status
 *
 * Flags:
 *   --port <n>       HTTP port (default: 8000)
 *   --pi-port <n>    Pi gateway port (default: 9999)
 *   --dev            Development mode (skip static files)
 *   --no-tunnel      Disable zrok tunnel
 */
import { createServer, type ServerConfig } from "./server.js";
import { loadConfig, ensureConfig } from "@blackbelt-technology/pi-dashboard-shared/config.js";
import {
  launchDashboardServer,
  JitiNotFoundError,
  PortConflictError,
  EarlyExitError,
} from "@blackbelt-technology/pi-dashboard-shared/server-launcher.js";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { readPid, removePid, isServerRunning } from "./server-pid.js";
import {
  findPortHolders as platformFindPortHolders,
  isProcessAlive as platformIsProcessAlive,
  killProcess as platformKillProcess,
  parseNetstatListeners as platformParseNetstatListeners,
} from "@blackbelt-technology/pi-dashboard-shared/platform/process.js";

// Re-exports for back-compat — other modules / tests may import these from cli.
export const parseNetstatListeners = platformParseNetstatListeners;
export function findPortHolders(
  port: number,
  execImpl?: (cmd: string, opts: { encoding: "utf-8" }) => string,
): number[] {
  return platformFindPortHolders(port, execImpl ? { exec: execImpl } : undefined);
}
import { isDashboardRunning } from "@blackbelt-technology/pi-dashboard-shared/server-identity.js";
import { discoverDashboard } from "@blackbelt-technology/pi-dashboard-shared/mdns-discovery.js";

import { assertNodeVersionSupported } from "./node-guard.js";
import { getDefaultRegistry } from "@blackbelt-technology/pi-dashboard-shared/tool-registry/index.js";
import { bootstrapInstall } from "@blackbelt-technology/pi-dashboard-shared/bootstrap-install.js";
import {
  findBundledExtension,
  registerBridgeExtension,
} from "@blackbelt-technology/pi-dashboard-shared/bridge-register.js";
import type { DashboardServer } from "./server.js";
import { updateBootstrapCompatibility } from "./pi-version-skew.js";
import type { BootstrapStateStore } from "./bootstrap-state.js";
import { parseDashboardStarter } from "@blackbelt-technology/pi-dashboard-shared/dashboard-starter.js";
import { bootstrapInstallFromList } from "./bootstrap-install-from-list.js";
import { installFailLoudNet, failLoudCrash, checkCrashBudget, pruneCrashLog } from "./fail-loud.js";
import { reclaimPorts } from "./reclaim-ports.js";

/**
 * Emit a stderr warning at CLI startup when the resolved pi version is
 * below `piCompatibility.minimum` (blocking) or below `.recommended`
 * (advisory). Reads from the already-populated `bootstrapState` so no
 * additional I/O happens here. See change: warn-pi-version-skew-in-cli.
 */
function logCompatibilityWarning(store: BootstrapStateStore): void {
  const s = store.get();
  const c = s.compatibility;
  if (!c || !c.current) return;
  // Below minimum: `updateBootstrapCompatibility` sets `error.message`.
  // We treat the presence of a blocking error + upgradeRecommended as the
  // below-minimum signal; `upgradeRecommended` alone means below-recommended.
  if (s.error?.message && c.upgradeRecommended) {
    console.error(
      `[bootstrap] ⚠ pi ${c.current} is below the required minimum ${c.minimum}.`,
    );
    console.error(
      `[bootstrap]   All pi-dependent features (sessions, resources, openspec) will return 503.`,
    );
    console.error(`[bootstrap]   Run: pi-dashboard upgrade-pi`);
    return;
  }
  if (c.upgradeRecommended) {
    console.warn(
      `[bootstrap] pi ${c.current} is below the recommended ${c.recommended} — consider running \`pi-dashboard upgrade-pi\``,
    );
  }
}

const SUBCOMMANDS = ["start", "stop", "restart", "status", "upgrade-pi", "resurrect"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

export interface ParsedArgs {
  subcommand: Subcommand | null;
  flags: Partial<ServerConfig>;
  /** Positional session id for `resurrect <id>`. Undefined for other subcommands. */
  resurrectId?: string;
}

/**
 * Parse CLI arguments into a subcommand + flags.
 * Exported for testing.
 */
export function parseArgs(args: string[]): ParsedArgs {
  const flags: Partial<ServerConfig> = {};
  let subcommand: Subcommand | null = null;
  let resurrectId: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    // Check for subcommand (first positional arg)
    if (!subcommand && SUBCOMMANDS.includes(arg as Subcommand)) {
      subcommand = arg as Subcommand;
      continue;
    }

    // `resurrect <id>` — capture the first non-flag positional after the
    // subcommand as the session id.
    if (subcommand === "resurrect" && resurrectId === undefined && !arg.startsWith("-")) {
      resurrectId = arg;
      continue;
    }

    if (arg === "--port" && next) {
      flags.port = parseInt(next, 10);
      i++;
    } else if (arg === "--pi-port" && next) {
      flags.piPort = parseInt(next, 10);
      i++;
    } else if (arg === "--dev") {
      flags.dev = true;
    } else if (arg === "--no-tunnel") {
      flags.tunnel = false;
    } else if (arg === "--fixture") {
      // Deterministic e2e/visual testing — equivalent to PI_DASHBOARD_FIXTURE_MODE=1.
      flags.fixtureMode = true;
    }
  }

  return { subcommand, flags, ...(resurrectId !== undefined ? { resurrectId } : {}) };
}

/**
 * Build the full server config from CLI flags, env vars, and config file.
 */
export function buildConfig(flags: Partial<ServerConfig>): ServerConfig {
  const fileConfig = loadConfig();
  return {
    port: flags.port ?? (parseInt(process.env.PI_DASHBOARD_PORT ?? "") || null) ?? fileConfig.port,
    piPort: flags.piPort ?? (parseInt(process.env.PI_DASHBOARD_PI_PORT ?? "") || null) ?? fileConfig.piPort,
    dev: flags.dev ?? false,
    autoShutdown: fileConfig.autoShutdown,
    shutdownIdleSeconds: fileConfig.shutdownIdleSeconds,
    tunnel: flags.tunnel ?? fileConfig.tunnel.enabled,
    tunnelReservedToken: fileConfig.tunnel.reservedToken,
    authConfig: fileConfig.auth,
    maxEventsPerSession: fileConfig.memoryLimits.maxEventsPerSession,
    maxStringFieldSize: fileConfig.memoryLimits.maxStringFieldSize,
    maxWsBufferBytes: fileConfig.memoryLimits.maxWsBufferBytes,
    maxHeapSizeMb: fileConfig.memoryLimits.maxHeapSizeMb,
    editor: fileConfig.editor,
    openspec: fileConfig.openspec,
    reattachPlacement: fileConfig.reattachPlacement,
    resurrectionSweepMs: fileConfig.resurrectionSweepMs,
    resolvedTrustedNetworks: fileConfig.resolvedTrustedNetworks,
    corsAllowedOrigins: fileConfig.cors.allowedOrigins,
    // Fixture mode (deterministic visual/e2e testing — disables mDNS-advertise,
    // browser-open, zrok, bootstrap-install; see server.ts isFixture gating).
    // The ServerConfig field has always been consumed by createServer, but no
    // boot path ever populated it — the "Gated by PI_DASHBOARD_FIXTURE_MODE=1"
    // contract was documented-not-wired. Wire it here so the real-e2e sandbox
    // (design-pass §1.2 closure-#1: fixture-advertise-OFF ⇒ sandbox invisible
    // to live mDNS discovery) actually gets a fixture server. `PI_SANDBOX` is
    // read directly in server.ts (net/auth-guard skip) and needs no wiring.
    fixtureMode:
      flags.fixtureMode ??
      (process.env.PI_DASHBOARD_FIXTURE_MODE === "1" ||
        process.env.PI_DASHBOARD_FIXTURE_MODE === "true"),
  };
}

/**
 * Run the server in the foreground (original behavior).
 *
 * After the server starts listening, the degraded-mode bootstrap kicks
 * off: if `pi` is not resolvable via the ToolRegistry, the server flips
 * `bootstrapState` to "installing" and begins a background
 * `bootstrapInstall`. Session-spawn and other pi-dependent endpoints
 * queue or 503 during this window (see change tasks §5).
 *
 * See change: unified-bootstrap-install.
 */
async function runForeground(config: ServerConfig): Promise<void> {
  assertNodeVersionSupported();

  // Crash-budget breaker (S5): if this server crash-looped recently, HALT the
  // loop by exiting 0 (with launchd KeepAlive={SuccessfulExit:false}, a 0-exit
  // is NOT respawned) instead of hot-spinning the same fatal fault every
  // ThrottleInterval. Converts an infinite 10s respawn loop into a clean stop
  // that surfaces loudly for a human. Cleared by pruneCrashLog() on a healthy
  // start (below) or by deleting ~/.pi/dashboard/crash-log.jsonl.
  const budget = checkCrashBudget();
  if (budget.tripped) {
    console.error(
      `[fail-loud] crash-budget breaker TRIPPED: ${budget.count} crashes in ` +
        `${Math.round(budget.windowMs / 1000)}s (>= ${budget.maxCrashes}). Halting respawn ` +
        `(exit 0, no restart). Investigate, then clear ~/.pi/dashboard/crash-log.jsonl.`,
    );
    process.exit(0);
  }

  const server = await createServer(config);

  // Fail-loud net (DEGRADE-THEN-CRASH) — replaces the old suppress-all net that
  // swallowed every uncaughtException and never exited (so the supervisor never
  // saw a crash and never restarted = the silent-zombie root of Fault B). Now an
  // otherwise-uncaught fault logs LOUD, runs teardown (flush meta / kill PTYs /
  // stop editors / delete tunnel / release home-lock), then exit(1) → a clean
  // supervised restart. Installed here (not main) so the server teardown is in
  // scope; the KNOWN recoverable seams are bounded locally in pi-gateway /
  // browser-gateway so only genuinely-unexpected faults reach this net.
  installFailLoudNet({ teardown: () => server.stop() });

  // Stamp the bootstrap state with who started this server process.
  // parseDashboardStarter defaults to "Standalone" when DASHBOARD_STARTER is unset.
  const starter = parseDashboardStarter(process.env);
  server.bootstrapState.set({ starter });
  console.log(`[bootstrap] starter=${starter}`);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      console.log("Force exit.");
      process.exit(1);
    }
    shuttingDown = true;
    console.log("\nShutting down...");
    await server.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Reconcile installable.json before binding the port.
  // Required-package failures throw and prevent server start.
  // Optional failures are logged and continue.
  // File-absent is a no-op (Bridge/Standalone starters don't seed installable.json).
  // See change: simplify-electron-bootstrap-derived-state.
  try {
    await bootstrapInstallFromList(server.bootstrapState);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[bootstrap] installable reconcile failed (required package): ${message}`);
    process.exit(1);
  }

  // Reclaim-on-start (Stage-2 (a)/(d)): BEFORE binding, kill any ORPHAN holding
  // :piPort/:port (+ its process group) so a previous instance's orphaned
  // listener can never EADDRINUSE us into a zombie (the 2026-07-04 rollback
  // race). Identity = who-holds-the-port (external OS fact), never the launchd
  // wrapper nor a stale server.pid. If a port is STILL held after reclaim, fail
  // loud → the supervisor restarts + reclaims again (never a silent bind-race).
  const reclaimTargets =
    process.env.PI_DASHBOARD_NO_RECLAIM === "1"
      ? []
      : [config.piPort, config.port].filter(
          (p): p is number => typeof p === "number" && p > 0,
        );
  if (process.env.PI_DASHBOARD_NO_RECLAIM === "1") {
    console.error(
      "[reclaim] DISABLED via PI_DASHBOARD_NO_RECLAIM=1 (operator escape-hatch / negative-control) — NOT reclaiming ports before bind",
    );
  }
  try {
    await reclaimPorts(reclaimTargets);
  } catch (err) {
    console.error(`[reclaim] ${err instanceof Error ? err.message : String(err)}`);
    await failLoudCrash(1, `port reclaim failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  await server.start();

  // Healthy start reached — prune old crash-log entries so a past transient does
  // not count toward the crash-budget breaker indefinitely.
  pruneCrashLog();

  // Kick off the degraded-mode first-run bootstrap if pi is unresolvable.
  // Runs async — server is already listening, so UI + non-pi endpoints
  // remain fully operational during the ~30s install window.
  // TODO(single-dashboard-per-home): when home-lock wiring lands, wrap
  // this inside the acquired lock to serialize concurrent first-run
  // installs from multiple dashboard invocations on the same HOME.
  runDegradedModeBootstrap(server).catch((err) => {
    console.error("[bootstrap] unexpected failure in bootstrap orchestrator:", err);
  });
}

/**
 * Orchestrate the first-run bootstrap flow.
 *
 *  - If pi is already resolvable → leave `bootstrapState` at the default
 *    "ready" and return immediately.
 *  - Otherwise flip to "installing", run `bootstrapInstall`, then:
 *      • on success, rescan the registry, attempt bridge registration
 *        (failures are non-fatal and land in `bridgeRegistrationError`),
 *        flip to "ready".
 *      • on failure, flip to "failed" with the error.
 *
 * Structured log lines at each transition aid diagnosis in daemon-mode
 * (stdout goes to ~/.pi/dashboard/server.log).
 */
async function runDegradedModeBootstrap(server: DashboardServer): Promise<void> {
  const registry = getDefaultRegistry();
  const initial = registry.resolve("pi");

  if (initial.ok) {
    // Default state is "ready" — no change needed. Log once for clarity.
    console.log(`[bootstrap] ready (pi resolved via ${initial.source})`);
    // Populate version-skew compatibility info even when no install was
    // needed — the UI banner renders upgradeRecommended hints.
    try {
      const serverPkg = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "package.json",
      );
      updateBootstrapCompatibility(server.bootstrapState, serverPkg);
      logCompatibilityWarning(server.bootstrapState);
    } catch (err) {
      console.warn("[bootstrap] version-skew check failed (non-fatal):", err);
    }
    return;
  }

  const installPackages = ["@earendil-works/pi-coding-agent", "@fission-ai/openspec"];
  server.bootstrapState.setLastInstallPackages(installPackages);
  console.log("[bootstrap] installing (pi unresolved, running background install)");
  server.bootstrapState.set({
    status: "installing",
    progress: { step: "pi", output: "starting install…" },
    error: undefined,
  });

  try {
    const res = await bootstrapInstall({
      packages: installPackages,
      progress: (p) => {
        server.bootstrapState.set({
          progress: { step: p.step, output: p.output },
        });
      },
    });

    if (!res.ok) {
      console.error(`[bootstrap] failed: ${res.error}`);
      server.bootstrapState.set({
        status: "failed",
        error: { message: res.error },
        progress: undefined,
      });
      return;
    }

    // Post-install registry rescan + openspec/pi-resources force-refresh
    // are now centralized in server.ts's bootstrapState.subscribe hook,
    // which fires on every installing → ready transition (this caller +
    // triggerUpgradePi + triggerRetry).
    // See change: fix-openspec-buttons-after-bootstrap-install.

    // Attempt bridge registration. Failures are non-fatal per spec §10.3.
    let bridgeErr: string | undefined;
    try {
      const extPath = findBundledExtension(process.cwd());
      if (extPath) {
        registerBridgeExtension(extPath);
      } else {
        bridgeErr = "bundled extension not found after install";
      }
    } catch (err) {
      bridgeErr = err instanceof Error ? err.message : String(err);
    }

    server.bootstrapState.set({
      status: "ready",
      progress: undefined,
      error: undefined,
      bridgeRegistrationError: bridgeErr,
    });
    // Populate compatibility info after a successful install.
    try {
      const serverPkg = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "package.json",
      );
      updateBootstrapCompatibility(server.bootstrapState, serverPkg);
      logCompatibilityWarning(server.bootstrapState);
    } catch (err) {
      console.warn("[bootstrap] version-skew check failed (non-fatal):", err);
    }
    console.log(
      `[bootstrap] ready (installed ${res.installed.join(", ")}${bridgeErr ? `; bridge warning: ${bridgeErr}` : ""})`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[bootstrap] failed: ${message}`);
    server.bootstrapState.set({
      status: "failed",
      error: { message },
      progress: undefined,
    });
  }
}

/**
 * Start the server as a detached background daemon.
 */
async function cmdStart(config: ServerConfig): Promise<void> {
  assertNodeVersionSupported();
  const running = await isServerRunning(config.port);
  if (running) {
    console.log(`Dashboard server is already running (pid ${running})`);
    return;
  }

  // Check if port is occupied by another service
  const portStatus = await isDashboardRunning(config.port);
  if (portStatus.portConflict) {
    console.error(`Port ${config.port} is occupied by another service (not the dashboard).`);
    console.error(`Change the port in ~/.pi/dashboard/config.json or use --port <n>`);
    process.exit(1);
  }

  // Spawn ourselves in foreground mode (no subcommand) as a detached process.
  // All concerns below — jiti loader resolution, --import argv URL-wrapping,
  // env merge, log-file header, readiness polling, port-conflict / early-exit
  // detection — are owned by the shared `launchDashboardServer` primitive.
  const cliPath = fileURLToPath(import.meta.url);
  const args: string[] = [];
  if (config.port !== 8000) args.push("--port", String(config.port));
  if (config.piPort !== 9999) args.push("--pi-port", String(config.piPort));
  if (config.dev) args.push("--dev");
  if (!config.tunnel) args.push("--no-tunnel");

  const logDir = path.join(os.homedir(), ".pi", "dashboard");
  const logPath = path.join(logDir, "server.log");

  try {
    const result = await launchDashboardServer({
      cliPath,
      extraArgs: args,
      nodeArgs: config.maxHeapSizeMb != null && config.maxHeapSizeMb > 0
        ? [`--max-old-space-size=${config.maxHeapSizeMb}`]
        : undefined,
      stdio: { logFile: logPath },
      starter: "Standalone",
      healthTimeoutMs: 30_000,
      port: config.port,
      env: { ...process.env },
    });
    const reportedPid = result.reportedPid ?? readPid() ?? result.childPid;
    console.log(`Dashboard server started (pid ${reportedPid}) at http://localhost:${config.port}`);
  } catch (err: unknown) {
    if (err instanceof JitiNotFoundError) {
      console.error(`[pi-dashboard] ${err.message}`);
      process.exit(1);
    }
    if (err instanceof PortConflictError) {
      console.error(`Port ${err.port} is occupied by another service (not the dashboard).`);
      console.error(`Change the port in ~/.pi/dashboard/config.json or use --port <n>`);
      process.exit(1);
    }
    if (err instanceof EarlyExitError) {
      console.error(`Failed to start dashboard server (child process exited with code ${err.code})`);
      console.error(`Check logs at ${logPath}`);
      process.exit(1);
    }
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`Failed to start dashboard server (${reason})`);
    console.error(`Check logs at ${logPath}`);
    process.exit(1);
  }
}

/**
 * Stop the running server daemon.
 */
/**
 * Kill a process by PID with logging. Delegates to the shared platform
 * primitive (`packages/shared/src/platform/process.ts`) which handles the
 * Windows (taskkill) vs Unix (SIGTERM→SIGKILL) split.
 * See change: consolidate-platform-handlers.
 */
async function killProcess(pid: number, label: string): Promise<boolean> {
  const result = await platformKillProcess(pid);
  if (!result.ok) return false;
  console.log(`${label} stopped${result.forced ? " (forced)" : ""} (pid ${pid})`);
  return true;
}

// Local alias to preserve prior internal references.
const isProcessAlive = (pid: number) => platformIsProcessAlive(pid);

async function cmdStop(): Promise<void> {
  const config = loadConfig();
  const pid = readPid();
  let stopped = false;

  // Try PID file first
  if (pid !== null) {
    if (isProcessAlive(pid)) {
      stopped = await killProcess(pid, "Dashboard server");
    } else {
      console.log("Dashboard server is not running (cleaned up stale PID file)");
    }
    removePid();
  }

  // Safety net: kill any process still holding our ports
  for (const port of [config.port, config.piPort]) {
    for (const holder of findPortHolders(port)) {
      if (holder !== pid) {
        console.log(`Killing stale process ${holder} on port ${port}`);
        await killProcess(holder, `Stale process on port ${port}`);
      }
    }
  }

  if (!stopped && pid === null) {
    console.log("Dashboard server is not running");
  }
}

/**
 * `pi-dashboard restart` — restart the daemon.
 *
 * If a dashboard is currently running, POST to `/api/restart` so the proven
 * `restart-helper.ts` orchestrator handles the stop/start atomically in a
 * detached child. This avoids the bridge-auto-start race that occurs when
 * `cmdStop()` kills the daemon in-process: every connected bridge sees its
 * WS close and fires `server-auto-start.ts`, racing the subsequent
 * `cmdStart()` to bind the port.
 *
 * If the dashboard is NOT running (or is unreachable), fall back to the
 * existing `cmdStop()` + `cmdStart()` sequence.
 *
 * See change: fix-restart-bridge-auto-start-race.
 */
export async function cmdRestart(
  config: ServerConfig,
  injected?: {
    isDashboardRunning?: typeof isDashboardRunning;
    fetchImpl?: typeof fetch;
    cmdStopImpl?: () => Promise<void>;
    cmdStartImpl?: (cfg: ServerConfig) => Promise<void>;
  },
): Promise<void> {
  const probe = injected?.isDashboardRunning ?? isDashboardRunning;
  const fetchFn = injected?.fetchImpl ?? fetch;
  const stopFn = injected?.cmdStopImpl ?? cmdStop;
  const startFn = injected?.cmdStartImpl ?? cmdStart;
  return cmdRestartImpl(config, probe, fetchFn, stopFn, startFn);
}

async function cmdRestartImpl(
  config: ServerConfig,
  probe: typeof isDashboardRunning,
  fetchFn: typeof fetch,
  stopFn: () => Promise<void>,
  startFn: (cfg: ServerConfig) => Promise<void>,
): Promise<void> {
  const status = await probe(config.port);
  if (status.running) {
    console.log(
      `[restart] dashboard running at http://localhost:${config.port}, delegating to /api/restart`,
    );
    try {
      const res = await fetchFn(`http://localhost:${config.port}/api/restart`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dev: !!config.dev }),
      });
      if (res.ok) {
        console.log("[restart] orchestrator queued; CLI exits now.");
        return;
      }
      const body = await res.text();
      console.error(
        `[restart] server rejected restart: HTTP ${res.status} ${body}; falling back to local stop/start`,
      );
    } catch (err) {
      console.error(
        `[restart] failed to reach server (${(err as Error).message ?? err}); falling back to local stop/start`,
      );
    }
    // Fall through to local sequence on HTTP failure so the user is never
    // left with a half-restarted server.
  }
  await stopFn();
  await startFn(config);
}

/**
 * Show server status.
 */
/**
 * `pi-dashboard upgrade-pi` — upgrade pi-coding-agent via bootstrap.
 *
 * If a dashboard is currently running, POST to /api/bootstrap/upgrade-pi
 * (so the running server owns the install, broadcasts state, and reloads
 * connected sessions). Otherwise run `bootstrapInstall` directly with a
 * streaming progress formatter and exit when done.
 *
 * See change: unified-bootstrap-install §8.
 */
async function cmdUpgradePi(config: ServerConfig): Promise<void> {
  const status = await isDashboardRunning(config.port);
  if (status.running) {
    console.log(
      `[upgrade-pi] dashboard running at http://localhost:${config.port}, delegating to server`,
    );
    try {
      const res = await fetch(`http://localhost:${config.port}/api/bootstrap/upgrade-pi`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = await res.text();
        console.error(`[upgrade-pi] server rejected upgrade: HTTP ${res.status} ${body}`);
        process.exit(1);
      }
      const body = (await res.json()) as { ticketId?: string };
      console.log(`[upgrade-pi] queued (ticketId=${body.ticketId ?? "?"})`);
      console.log("[upgrade-pi] progress is streamed to open dashboard tabs; CLI exits now.");
      return;
    } catch (err) {
      console.error("[upgrade-pi] failed to reach server:", err);
      process.exit(1);
    }
  }

  console.log("[upgrade-pi] no dashboard running — installing directly");
  const res = await bootstrapInstall({
    packages: ["@earendil-works/pi-coding-agent"],
    progress: (p) => {
      const line = p.output
        ? `[upgrade-pi] ${p.step} ${p.status}: ${p.output}`
        : `[upgrade-pi] ${p.step} ${p.status}`;
      console.log(line);
    },
  });
  if (!res.ok) {
    console.error(`[upgrade-pi] failed: ${res.error}`);
    process.exit(1);
  }
  console.log(`[upgrade-pi] ✓ installed ${res.installed.join(", ")}`);
}

/**
 * `pi-dashboard resurrect <id>` — Component B CLI sugar (session-resurrection
 * design-pass §4). POSTs `/api/session/:id/resurrect` to the running dashboard,
 * which performs the state-aware bring-back (display / takeover / respawn).
 * Requires a running dashboard — there is no offline resurrect (the server owns
 * the session registry + spawn path).
 */
async function cmdResurrect(config: ServerConfig, id: string | undefined): Promise<void> {
  if (!id) {
    console.error("[resurrect] usage: pi-dashboard resurrect <session-id>");
    process.exit(1);
  }
  const status = await isDashboardRunning(config.port);
  if (!status.running) {
    console.error(
      `[resurrect] no dashboard running on port ${config.port}; start one first (pi-dashboard start)`,
    );
    process.exit(1);
  }
  try {
    const res = await fetch(
      `http://localhost:${config.port}/api/session/${encodeURIComponent(id!)}/resurrect`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    const body = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      error?: string;
      data?: { resurrected?: boolean; mode?: string };
    };
    if (!res.ok || body.success === false) {
      console.error(`[resurrect] failed: HTTP ${res.status} ${body.error ?? ""}`.trim());
      process.exit(1);
    }
    const mode = body.data?.mode ?? "?";
    console.log(`[resurrect] ✓ session ${id} resurrected (mode: ${mode})`);
  } catch (err) {
    console.error(`[resurrect] failed to reach server: ${(err as Error).message ?? err}`);
    process.exit(1);
  }
}

async function cmdStatus(port: number): Promise<void> {
  // 1. Try mDNS discovery first
  try {
    const servers = await discoverDashboard(2000);
    const local = servers.find(s => s.isLocal);
    if (local) {
      // Verify via health check for uptime info
      try {
        const res = await fetch(`http://${local.host}:${local.port}/api/health`);
        if (res.ok) {
          const data = await res.json() as { pid: number; uptime: number };
          console.log(`Dashboard server is running (pid ${data.pid}) on ${local.host}:${local.port}, uptime ${data.uptime}s (discovered via mDNS)`);
          return;
        }
      } catch { /* fall through */ }
      console.log(`Dashboard server discovered via mDNS at ${local.host}:${local.port} (pid ${local.pid})`);
      return;
    }
  } catch {
    // mDNS failed — fall through to PID file check
  }

  // 2. Fallback: PID file + health check
  const pid = readPid();

  if (pid === null) {
    console.log("Dashboard server is not running");
    process.exit(1);
    return;
  }

  if (!isProcessAlive(pid)) {
    removePid();
    console.log("Dashboard server is not running (cleaned up stale PID file)");
    process.exit(1);
    return;
  }

  // Try health endpoint for richer info
  try {
    const res = await fetch(`http://localhost:${port}/api/health`);
    if (res.ok) {
      const data = await res.json() as { pid: number; uptime: number };
      console.log(`Dashboard server is running (pid ${data.pid}) on port ${port}, uptime ${data.uptime}s`);
      return;
    }
  } catch {
    // Fall back to basic info
  }

  console.log(`Dashboard server is running (pid ${pid}) on port ${port}`);
}

/**
 * NOTE: the fail-loud crash net (degrade-then-crash) is installed in
 * runForeground() where the server teardown is in scope — see fail-loud.ts.
 * The old suppress-all `installCrashSafetyNet` is intentionally GONE: swallowing
 * every uncaughtException emitted no exit code, so the supervising harness never
 * saw a crash and never restarted (the silent-zombie root of Fault B).
 */

async function main() {
  ensureConfig();

  const { subcommand, flags, resurrectId } = parseArgs(process.argv.slice(2));
  const config = buildConfig(flags);

  switch (subcommand) {
    case "start":
      await cmdStart(config);
      break;
    case "stop":
      await cmdStop();
      break;
    case "restart":
      await cmdRestart(config);
      break;
    case "status":
      await cmdStatus(config.port);
      break;
    case "upgrade-pi":
      await cmdUpgradePi(config);
      break;
    case "resurrect":
      await cmdResurrect(config, resurrectId);
      break;
    default:
      // No subcommand — run in foreground (backward compatible)
      await runForeground(config);
      break;
  }
}

// Only run when executed directly (not when imported for testing)
const isDirectExecution = process.argv[1] &&
  (process.argv[1].endsWith("cli.ts") || process.argv[1].endsWith("cli.js") || process.argv[1].endsWith("pi-dashboard"));

if (isDirectExecution) {
  main().catch((err) => {
    console.error("Failed to start dashboard:", err);
    process.exit(1);
  });
}
