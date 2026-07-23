/**
 * System REST API routes: config, health, shutdown, tunnel, editors.
 */
import type { FastifyInstance } from "fastify";
import type { SessionManager } from "../memory-session-manager.js";
import type { PreferencesStore } from "../preferences-store.js";
import type { MetaPersistence } from "../meta-persistence.js";
import type { DirectoryService } from "../directory-service.js";
import type { PiGateway } from "../pi-gateway.js";
import type { EventStore } from "../memory-event-store.js";
import type { ServerConfig } from "../server.js";
import type { ApiResponse } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import type { NetworkGuard } from "./route-deps.js";
import { detectEditors, EDITORS } from "../editor-registry.js";
import { detectCodeServerBinary, resetDetectionCache } from "../editor-detection.js";
import { readConfigRedacted, writeConfigPartial } from "../config-api.js";
import { createTunnel, deleteTunnel, getTunnelStatus } from "../tunnel.js";
import { getModelProxyStatus } from "../model-proxy/registry-singleton.js";
import { getModelProxySecondPortStatus } from "../model-proxy-second-port.js";
import { spawnRestart } from "../restart-helper.js";
import { classifyHeap, readHeapStats } from "../heap-watchdog.js";
import { spawn } from "@blackbelt-technology/pi-dashboard-shared/platform/exec.js";
import path from "node:path";
import os from "node:os";
import { localhostGuard, netmaskToCidrBits, networkAddress } from "../localhost-guard.js";
import { readSpawnFailures } from "../spawn-failure-log.js";
import { getPluginStatusStore } from "@blackbelt-technology/dashboard-plugin-runtime/server";
import type { NetworkInterface } from "@blackbelt-technology/pi-dashboard-shared/rest-api.js";
import type { BootstrapStateStore } from "../bootstrap-state.js";
import { classifyCellHttpActor } from "../cell-access-http.js";

export function registerSystemRoutes(
  fastify: FastifyInstance,
  deps: {
    sessionManager: SessionManager;
    preferencesStore: PreferencesStore;
    metaPersistence: MetaPersistence;
    config: ServerConfig;
    networkGuard: NetworkGuard;
    version?: string;
    commit?: string;
    directoryService?: DirectoryService;
    piGateway?: PiGateway;
    bootstrapState?: BootstrapStateStore;
    eventStore?: EventStore;
    cellAccess?: import("../cell-access.js").CellAccessController;
    onCellAccessChanged?: () => void;
  },
) {
  const { sessionManager, preferencesStore, metaPersistence, config, networkGuard, version, commit, directoryService, piGateway, bootstrapState, eventStore } = deps;

  // Build 0 (PRINCIPAL-CAPTURE): freeze the multi-operator browser-auth gate
  // flag at route-registration time (== server startup — this runs before any
  // `/api/config` reload can mutate `config.authConfig`). BOTH live gates (the
  // `/ws` upgrade check + the browser gateway's send-seam gate) read this ONE
  // startup-frozen boolean, never the mutable `config.authConfig` field, so a
  // runtime flip cannot desync them (the flag is restart-required). H-NIT1
  // (Build 1b): the previous "re-pin `config.authConfig.requireBrowserAuth =
  // <frozen>` after reload" was DEAD — no live gate ever reads that mutable
  // field — so it was removed (test-it-or-remove-it: removed).
  const requireBrowserAuthAtStartup = config.authConfig?.requireBrowserAuth === true;
  // H-M3 (Build 1b): capture the startup verifier secret so a runtime
  // `PUT /api/config {requireBrowserAuth:false}` under a frozen-ON gate cannot
  // DROP the secret and lock out still-valid cookies. In flag-only-no-provider
  // mode `loadConfig()` collapses a secret-only auth block to `undefined` on
  // reload (config.ts secret-only rule) → `config.authConfig=undefined` → the
  // frozen-ON `/ws` gate would 401 even valid old cookies. We preserve the prior
  // secret on the reassigned auth object below so the gate keeps verifying.
  const authSecretAtStartup = config.authConfig?.secret;

  // Quiesce windows for the bridge `server_restarting` broadcast. See change
  // `fix-restart-bridge-auto-start-race`. Bridges that receive this message
  // suppress only the spawn step in `server-auto-start.ts` for `quiesceMs`;
  // discovery + reconnection still run.
  const RESTART_QUIESCE_MS = 5000;
  const SHUTDOWN_QUIESCE_MS = 60000;
  const announceRestart = (reason: "restart" | "shutdown", quiesceMs: number) => {
    if (!piGateway) return;
    try {
      piGateway.broadcast({ type: "server_restarting", reason, quiesceMs });
    } catch { /* best-effort — never block exit on a flaky bridge socket */ }
  };
  const serverStartTime = Date.now();

  // Editor detection endpoint
  fastify.get<{ Querystring: { path?: string } }>(
    "/api/editors",
    { preHandler: networkGuard },
    async (request) => {
      const cwd = request.query.path;
      if (!cwd) {
        return { success: false, error: "path parameter required" } satisfies ApiResponse;
      }
      const editors = detectEditors(cwd);
      return { success: true, data: editors } satisfies ApiResponse;
    },
  );

  // code-server binary detection endpoint
  fastify.get(
    "/api/editor/detect",
    { preHandler: networkGuard },
    async () => {
      resetDetectionCache();
      const result = detectCodeServerBinary(config.editor);
      return { success: true, data: result } satisfies ApiResponse;
    },
  );

  // Open editor endpoint
  fastify.post<{ Body: { path?: string; editor?: string; file?: string; line?: number } }>(
    "/api/open-editor",
    { preHandler: networkGuard },
    async (request) => {
      const { path: cwd, editor: editorId, file, line } = request.body ?? {};
      if (!cwd || !editorId) {
        return { success: false, error: "path and editor required" } satisfies ApiResponse;
      }

      const allSessions = sessionManager.listAll();
      if (!allSessions.some((s) => s.cwd === cwd)) {
        return { success: false, error: "unknown session path" } satisfies ApiResponse;
      }

      const editorEntry = EDITORS.find((e) => e.id === editorId);
      if (!editorEntry) {
        return { success: false, error: "unknown editor" } satisfies ApiResponse;
      }

      const target = file ? path.resolve(cwd, file) : cwd;
      const args = line && file ? [`${target}:${line}`] : [target];

      try {
        const child = spawn(editorEntry.cli, args, {
          detached: true,
          stdio: "ignore",
        });
        child.unref();
        return { success: true } satisfies ApiResponse;
      } catch (err: any) {
        return { success: false, error: `failed to open editor: ${err.message}` } satisfies ApiResponse;
      }
    },
  );

  // Config endpoints
  fastify.get(
    "/api/config",
    { preHandler: networkGuard },
    async () => {
      return { success: true, data: readConfigRedacted() };
    },
  );

  fastify.put(
    "/api/config",
    { preHandler: networkGuard },
    async (request, reply) => {
      const partial = request.body as Record<string, any>;
      if (!partial || typeof partial !== "object") {
        return reply.code(400).send({ success: false, error: "Invalid body" });
      }
      const result = writeConfigPartial(partial);
      if (!result.success) {
        // H-M1 (Build 1b): a malformed security-flag write is a client error
        // (400 — reject + preserve prior value), distinct from a genuine
        // disk/serialize failure (500). FOLD-E N1 (PUSHBACK-1): key the split on
        // the STRUCTURED `validationError` flag, not a brittle English-substring
        // match on the error text (the substring stays as a defensive fallback
        // for any pre-flag caller).
        const isValidationError =
          result.validationError === true ||
          (typeof result.error === "string" && result.error.includes("must be a boolean"));
        return reply
          .code(isValidationError ? 400 : 500)
          .send({ success: false, error: result.error });
      }

      // Apply runtime-safe changes
      const reloaded = (await import("@blackbelt-technology/pi-dashboard-shared/config.js")).loadConfig();
      if (partial.autoShutdown !== undefined || partial.shutdownIdleSeconds !== undefined) {
        config.autoShutdown = reloaded.autoShutdown;
        config.shutdownIdleSeconds = reloaded.shutdownIdleSeconds;
      }
      if (partial.auth !== undefined) {
        config.authConfig = reloaded.auth;
        // Build 0/1b: the multi-operator browser-auth gate is restart-required.
        // Both live gates read the STARTUP-FROZEN boolean, NOT this reassigned
        // object, so a flip only takes effect on restart (writeConfigPartial
        // returns restartRequired:true). Secret/provider/bypass changes still
        // apply live via _reloadAuth below.
        //
        // H-M3 (Build 1b): preserve the verifier secret across the reload when
        // the gate was frozen ON. In flag-only-no-provider mode a runtime
        // `{requireBrowserAuth:false}` write makes `loadConfig()` drop the
        // secret-only auth block to `undefined` (config.ts secret-only rule),
        // which would leave the frozen-ON `/ws` gate with NO secret → it would
        // 401 even still-valid old cookies (a self-inflicted lockout). If the
        // reload produced no auth block (or a secretless one) but we froze ON
        // with a secret, reconstruct a minimal auth object carrying the prior
        // secret so the gate keeps verifying existing cookies until restart.
        if (requireBrowserAuthAtStartup && authSecretAtStartup) {
          if (!config.authConfig) {
            config.authConfig = { secret: authSecretAtStartup, providers: {} };
          } else if (!config.authConfig.secret) {
            config.authConfig.secret = authSecretAtStartup;
          }
        }
        if (partial.auth.allowedUsers !== undefined && deps.cellAccess?.enabled) {
          deps.cellAccess.updateAllowedUsers(reloaded.auth?.allowedUsers);
          deps.onCellAccessChanged?.();
        }
        if (reloaded.auth && (fastify as any)._reloadAuth) {
          await (fastify as any)._reloadAuth(reloaded.auth);
        }
      }
      if (partial.openspec !== undefined && directoryService) {
        directoryService.reconfigurePolling(reloaded.openspec);
      }
      if (partial.push !== undefined) {
        config.push = reloaded.push;
      }

      return { success: true, restartRequired: result.restartRequired };
    },
  );

  // Tunnel endpoints
  fastify.get("/api/tunnel-status", async () => {
    return getTunnelStatus();
  });

  fastify.post("/api/tunnel-connect", async () => {
    const status = getTunnelStatus();
    if (status.status === "active") return { ok: true, url: status.url };
    if (status.status === "unavailable") return { ok: false, error: "zrok not installed" };
    const url = await createTunnel(config.port, config.tunnelReservedToken);
    if (url) return { ok: true, url };
    return { ok: false, error: "Failed to create tunnel" };
  });

  fastify.post("/api/tunnel-disconnect", async () => {
    // Pass port so orphan zrok processes bound to this endpoint are also
    // swept (not just the one we tracked via pid-file).
    await deleteTunnel(config.port);
    return { ok: true };
  });

  // Health endpoint — includes server + agent process metrics
  fastify.get("/api/health", async (request) => {
    const mem = process.memoryUsage();
    // Real V8 cap axis — dissolves the heapUsed/heapTotal ~96% illusion. heapLimit
    // is the hard cap (v8 heap_size_limit, set by NODE_OPTIONS --max-old-space-size,
    // e.g. 8 GiB here); heapRatio is heapUsed/heapLimit (~26%, the truth). Reuses
    // the heap-watchdog's live reader + ratio computation rather than re-deriving.
    const heapStats = classifyHeap(readHeapStats(), 0.70, 0.85);
    const activeSessions = sessionManager.listActive();
    const agentMetrics = activeSessions
      .filter(s => s.processMetrics)
      .map(s => ({
        sessionId: s.id,
        cwd: s.cwd,
        ...s.processMetrics,
      }));
    const health: Record<string, unknown> = {
      ok: true,
      pid: process.pid,
      starter: bootstrapState?.get().starter ?? "Standalone",
      installable: bootstrapState?.get().installable,
      version: version ?? "unknown",
      // Deploy provenance (Stage-1a boundary): the committed sha this prod runs,
      // resolved from RELEASE.json (deploy.mjs stamp) via server.ts. "dev-worktree"
      // when running an un-deployed working tree — the negative-control signal.
      commit: commit ?? "dev-worktree",
      // Is the pi gateway (:9999) actually bound + listening?
      gatewayListening: piGateway?.address?.() != null,
      uptime: Math.floor((Date.now() - serverStartTime) / 1000),
      mode: config.dev ? "dev" : "production",
      server: {
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        // V8 hard cap + real-cap ratio: the axis that dissolves the ~96%-of-heapTotal
        // vs ~26%-of-heapLimit confusion. Sourced from heap-watchdog.readHeapStats().
        heapLimit: heapStats.heapLimit,
        heapRatio: heapStats.ratio,
        activeSessions: activeSessions.length,
        totalSessions: sessionManager.listAll().length,
        // Serialized bytes retained in the in-memory event store — the byte
        // tier the count-only LRU never bounded. Surfaced for leak tracking.
        eventStoreBytes: eventStore?.bytesRetained() ?? 0,
        eventStoreSessions: eventStore?.sessionCount() ?? 0,
      },
      agents: agentMetrics,
      plugins: getPluginStatusStore().listAll(),
      proxy: getModelProxyStatus(),
      proxySecondPort: getModelProxySecondPortStatus(),
    };

    // Surface push config errors when push is enabled but misconfigured.
    // See change: add-server-push-notifications.
    if (config.push?.enabled && config.push.errors && config.push.errors.length > 0) {
      health.push = { errors: config.push.errors };
    }

    if (deps.cellAccess?.enabled) {
      const actor = classifyCellHttpActor(request, deps.cellAccess);
      const principal = (request as any).restPrincipal ?? null;
      if (
        actor === "guest"
        || actor === "anonymous"
        || (actor === "operator" && !deps.cellAccess.isPrincipalAdmitted(principal))
      ) {
        return {
          ok: health.ok,
          version: health.version,
          commit: health.commit,
          uptime: health.uptime,
          mode: health.mode,
          gatewayListening: health.gatewayListening,
        };
      }
    }
    return health;
  });

  // Shutdown endpoint — used by devBuildOnReload
  fastify.post(
    "/api/shutdown",
    { preHandler: networkGuard },
    async () => {
      metaPersistence.flushAll();
      preferencesStore.flush();
      // Tell every connected bridge that the server is going away deliberately
      // BEFORE we start tearing down state, so bridges suppress auto-start.
      // See change: fix-restart-bridge-auto-start-race.
      announceRestart("shutdown", SHUTDOWN_QUIESCE_MS);
      // Tear down the zrok tunnel (and sweep orphans on our port) so restarts
      // don't leak reservations that leave stale URLs backed by nothing.
      try { await deleteTunnel(config.port); } catch { /* best-effort */ }
      setTimeout(() => process.exit(0), 100);
      return { ok: true };
    },
  );

  // Re-extract endpoint — Electron-only; 403 for Bridge/Standalone, 202 for Electron.
  // See change: simplify-electron-bootstrap-derived-state (task 6.4).
  fastify.post(
    "/api/electron/reextract",
    { preHandler: networkGuard },
    async (_request, reply) => {
      const starter = bootstrapState?.get().starter ?? "Standalone";
      if (starter !== "Electron") {
        reply.status(403);
        return {
          error: "reextract_not_allowed",
          message: `Re-extract is only available when the server was started by Electron (current starter: ${starter})`,
          starter,
        };
      }
      reply.status(202);
      return { ok: true, message: "Re-extraction scheduled. Electron will restart the server." };
    },
  );

  // Restart endpoint — flush state, spawn new server, then exit
  fastify.post<{ Body: { dev?: boolean } }>(
    "/api/restart",
    { preHandler: networkGuard },
    async (request) => {
      metaPersistence.flushAll();
      preferencesStore.flush();

      // Announce restart to every bridge BEFORE spawning the replacement so
      // bridges suppress their auto-start spawn step and don't race the
      // orchestrator. See change: fix-restart-bridge-auto-start-race.
      announceRestart("restart", RESTART_QUIESCE_MS);

      // Tear down tunnel before spawning the replacement process so the new
      // server doesn't race an orphan zrok agent on the same port.
      try { await deleteTunnel(config.port); } catch { /* best-effort */ }

      const cliPath = process.argv[1];
      if (!cliPath) return { ok: false, error: "Cannot determine CLI path" };

      // Find the TypeScript loader from process.execArgv (--import <loader>)
      const importIdx = process.execArgv.indexOf("--import");
      const loader = importIdx >= 0 ? (process.execArgv[importIdx + 1] ?? "") : "";

      // Allow overriding dev mode via request body
      const useDev = request.body?.dev ?? config.dev;
      const extraArgs: string[] = [];
      if (useDev) extraArgs.push("--dev");

      // Cross-platform restart: spawns a detached Node orchestrator that
      // polls the port via net, spawns the new server, polls /api/health
      // via http. No dependency on sh/lsof/curl — works on Windows too.
      // See change: fix-windows-server-parity.
      // Single control plane under launchd (Stage-2 (d)): restart THROUGH launchd
      // (`kickstart -k`) so the replacement stays a launchd-managed child that
      // KeepAlive still governs. The detached orchestrator (fallback below)
      // spawns a server that ESCAPES launchd, AND with KeepAlive it used to
      // double-spawn (launchd respawn + orchestrator) = the duplicate-starter
      // storm. reclaim-on-start makes the fresh launchd instance bind clean.
      const supervisor = process.env.DASHBOARD_SUPERVISOR;
      const launchdLabel = process.env.DASHBOARD_LAUNCHD_LABEL;
      if (supervisor === "launchd" && launchdLabel) {
        const uid = typeof process.getuid === "function" ? process.getuid() : 0;
        const target = `gui/${uid}/${launchdLabel}`;
        try {
          // Detached so it survives our imminent teardown; kickstart -k kills
          // this job (the wrapper forwards SIGTERM to us) then starts fresh.
          const child = spawn("launchctl", ["kickstart", "-k", target], {
            detached: true,
            stdio: "ignore",
          });
          child.unref();
          return { ok: true, via: "launchctl-kickstart", target };
        } catch (err) {
          console.error(
            `[restart] launchctl kickstart failed (${err instanceof Error ? err.message : String(err)}); falling back to orchestrator`,
          );
        }
      }

      // Fallback (non-launchd / dev / Windows / e2e-sandbox): detached
      // orchestrator + self-exit. reclaim-on-start in the replacement still
      // guarantees a clean bind (no EADDRINUSE zombie).
      spawnRestart({
        cliPath,
        loader,
        port: config.port,
        extraArgs,
        maxHeapSizeMb: config.maxHeapSizeMb,
      });

      setTimeout(() => process.exit(0), 200);
      return { ok: true };
    },
  );

  // Network interfaces for trusted networks UI (localhost-only for security)
  // GET /api/spawn-failures — rolling log of failed spawn attempts. See change: spawn-failure-diagnostics.
  fastify.get<{ Querystring: { limit?: string } }>(
    "/api/spawn-failures",
    async (request) => {
      const rawLimit = request.query.limit;
      const parsed = rawLimit !== undefined ? parseInt(rawLimit, 10) : NaN;
      const limit = Number.isNaN(parsed) ? 50 : parsed;
      const entries = readSpawnFailures(limit);
      return { entries };
    },
  );

  fastify.get(
    "/api/network-interfaces",
    { preHandler: localhostGuard },
    async () => {
      const interfaces = os.networkInterfaces();
      const result: NetworkInterface[] = [];
      for (const [name, addrs] of Object.entries(interfaces)) {
        if (!addrs) continue;
        for (const info of addrs) {
          if (info.internal || info.family !== "IPv4") continue;
          const bits = netmaskToCidrBits(info.netmask);
          const net = networkAddress(info.address, info.netmask);
          result.push({
            name,
            address: info.address,
            netmask: info.netmask,
            cidr: `${net}/${bits}`,
          });
        }
      }
      return { success: true, data: result };
    },
  );
}
