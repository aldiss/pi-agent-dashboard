/**
 * Auto-start logic for the dashboard server.
 * Uses mDNS discovery first, falls back to health check, then auto-starts.
 */
import os from "node:os";
import path from "node:path";

export interface DiscoveredServer {
  host: string;
  port: number;
  piPort: number;
  isLocal: boolean;
  source: "mdns" | "fallback";
}

export interface AutoStartDeps {
  discoverDashboard: (timeout?: number) => Promise<DiscoveredServer[]>;
  isDashboardRunning: (port: number) => Promise<{ running: boolean; portConflict?: boolean }>;
  launchServer: (config: any) => Promise<{ success: boolean; message: string }>;
  notify: (message: string, level: "info" | "warning") => void;
  /**
   * Optional callback fired immediately BEFORE `launchServer(config)` is
   * invoked. Used by TUI-aware callers (bridge extension) to show a
   * "starting dashboard server" spinner. NOT fired during mDNS discovery
   * or health-check phases — only when an actual server process is
   * about to be spawned.
   */
  onLaunchStart?: () => void;
  /**
   * Optional callback fired after `launchServer` resolves (success or
   * failure), AND after the post-launch mDNS re-discovery + recheck.
   * Passes the final success state so the caller can clear spinners.
   */
  onLaunchEnd?: (success: boolean) => void;
  /**
   * Optional predicate. When it returns true, the auto-start spawn step
   * (step 3 below) is skipped — mDNS discovery + health check still run,
   * so the bridge will pick up the orchestrator-spawned replacement as
   * soon as it advertises. Used by the bridge to honor `server_restarting`
   * bursts. See change: fix-restart-bridge-auto-start-race.
   */
  shouldSuppressAutoStart?: () => boolean;
}

export interface AutoStartResult {
  /** The server to connect to (if found or launched) */
  server?: { host: string; port: number; piPort: number };
}

/**
 * Discover or auto-start the dashboard server.
 * Discovery chain: pinned-URL guard → mDNS browse → health check fallback → auto-start.
 * Returns the server to connect to (empty when pinned — caller keeps its URL).
 */
export async function autoStartServer(
  config: { piPort: number; port: number; autoStart: boolean; pinnedUrl?: string },
  deps: AutoStartDeps,
): Promise<AutoStartResult> {
  // 0. ISOLATION GUARD — pinned ⇒ no discovery, no auto-start.
  //
  // When `PI_DASHBOARD_URL` is explicitly set the bridge passes it here as
  // `pinnedUrl`. A pinned session must NEVER discover or auto-start a server:
  // it stays anchored to the URL its ConnectionManager was constructed with
  // (the `pinnedUrl ?? localhost` capture in bridge.ts initBridge). Returning
  // `{}` means `result.server` is undefined, so the ONLY production
  // `connection.updateUrl` caller (the bridge's `autoStartServer().then`
  // repoint, gated on `result.server`) is never reached.
  //
  // This closes BOTH cross-wire vectors that hijacked the live crew (dl-2942 /
  // dl-2976), for the LIFETIME of the session — not just the initial connect:
  //   • Vector 1 (mDNS-discovery-first, the `discoverDashboard` step below):
  //     skipped entirely — no discovery, so no `updateUrl` to a discovered
  //     `isLocal` server.
  //   • Vector 2 (reconnect-to-cached-host, ConnectionManager.scheduleReconnect
  //     revert): because `updateUrl` is never called, `this.url` stays ===
  //     `lastWorkingUrl` forever, so the revert branch (gated on
  //     `url !== lastWorkingUrl`) can never fire. A forced reconnect therefore
  //     always re-targets the pin.
  //
  // The guard is at the TOP so it governs every entry into this function — the
  // initial connect AND any future code path that re-enters discovery.
  // See: nos-real-e2e-test-infrastructure/v1 design-pass §1.2 (composes on the
  // deployed ff63726 mDNS-hardening base; orthogonal isolation layer).
  if (config.pinnedUrl) {
    return {};
  }

  // 1. Try mDNS discovery (2s timeout)
  try {
    const servers = await deps.discoverDashboard(2000);
    const local = servers.find(s => s.isLocal);
    if (local) {
      // A local server is always reachable via `localhost`. Do NOT use the
      // mDNS-advertised `local.host` here: Bonjour can advertise the bare OS
      // computer-name (e.g. `vaceslavs-macbook-pro`) which is NOT DNS-resolvable
      // without the `.local` suffix, so connecting to `ws://<bare-name>:<port>`
      // fails at hostname resolution (undici onerror, upstream of TCP SYN) and
      // the bridge falls into a reconnect-loop-to-a-dead-URL → 0-bridge.
      // See change: fix-mdns-local-host-hijack.
      return { server: { host: "localhost", port: local.port, piPort: local.piPort } };
    }
    // Remote servers exist but no local — fall through to health check
  } catch {
    // mDNS failed — fall through to health check
  }

  // 2. Fallback: health check on configured port
  const status = await deps.isDashboardRunning(config.port);
  if (status.running) {
    return { server: { host: "localhost", port: config.port, piPort: config.piPort } };
  }

  if (!config.autoStart) return {};

  if (status.portConflict) {
    deps.notify(`Port ${config.port} is occupied by another service`, "warning");
    return {};
  }

  // Suppress the spawn step while a deliberate restart/shutdown is in
  // flight. Discovery + health check above already ran, so if the
  // orchestrator has finished bringing up the replacement we already
  // returned. See change: fix-restart-bridge-auto-start-race.
  if (deps.shouldSuppressAutoStart?.()) {
    return {};
  }

  // 3. Auto-start server
  deps.onLaunchStart?.();
  const result = await deps.launchServer(config);
  if (result.success) {
    deps.onLaunchEnd?.(true);
    deps.notify(`🌐 Dashboard started at http://localhost:${config.port}`, "info");

    // Wait for mDNS advertisement from the newly started server (up to 10s)
    try {
      const discovered = await deps.discoverDashboard(10000);
      const local = discovered.find(s => s.isLocal);
      if (local) {
        // Local server → always use `localhost` (see fix-mdns-local-host-hijack
        // above): the mDNS-advertised bare host may be DNS-unresolvable.
        return { server: { host: "localhost", port: local.port, piPort: local.piPort } };
      }
    } catch {
      // mDNS failed — use config defaults
    }

    return { server: { host: "localhost", port: config.port, piPort: config.piPort } };
  }

  // Another agent may have started the server concurrently — recheck before warning
  const recheck = await deps.isDashboardRunning(config.port);
  if (recheck.running) {
    deps.onLaunchEnd?.(true);
    return { server: { host: "localhost", port: config.port, piPort: config.piPort } };
  }

  // Surface the log path so users can inspect the crash output without having
  // to know the convention. See change: fix-windows-server-parity.
  deps.onLaunchEnd?.(false);
  const logPath = path.join(os.homedir(), ".pi", "dashboard", "server.log");
  deps.notify(
    `Dashboard server failed to start: ${result.message}\nSee log: ${logPath}`,
    "warning",
  );
  return {};
}
