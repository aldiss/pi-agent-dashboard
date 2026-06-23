/**
 * Session bootstrap: discovers sessions from known directories and starts OpenSpec polling.
 * Called during server startup (async, non-blocking).
 */
import type { SessionManager } from "./memory-session-manager.js";
import type { BrowserGateway } from "./browser-gateway.js";
import { isOpenSpecDataEmpty, type DirectoryService } from "./directory-service.js";
import { extractSessionStats } from "./session-stats-reader.js";
import { resolveDriverLiveness } from "./driver-liveness.js";

export interface SessionBootstrapDeps {
  sessionManager: SessionManager;
  browserGateway: BrowserGateway;
  directoryService: DirectoryService;
}

/**
 * Discover sessions from all known directories and broadcast them.
 * Runs async and does not block server startup.
 */
export async function discoverAndBroadcastSessions(deps: SessionBootstrapDeps): Promise<void> {
  const { sessionManager, browserGateway, directoryService } = deps;

  try {
    const dirs = directoryService.knownDirectories();
    for (const cwd of dirs) {
      const discovered = directoryService.discoverSessions(cwd);
      for (const hist of discovered) {
        if (!sessionManager.get(hist.id)) {
          let contextTokens: number | undefined;
          let contextWindow: number | undefined;
          let model: string | undefined;
          // Only the pi stats reader is whole-file (readFileSync). CC logs can be
          // 20 MB+ with 7 MB+ single lines, so NEVER run it on a CC session —
          // that would OOM the bootstrap path. CC stats are byte-bounded-derived
          // lazily on transcript load instead. See change: add-claude-code-session-viewing.
          if (hist.sessionFile && hist.source !== "claude-code") {
            try {
              const stats = extractSessionStats(hist.sessionFile);
              if (stats) {
                contextTokens = stats.lastTotalTokens;
                contextWindow = stats.contextWindow;
                model = stats.model;
              }
            } catch { /* ignore */ }
          }
          // Track 4, Fix L — false-ended-while-alive fix. Bootstrap defaults a
          // reconstructed session to ended+hidden, but a pi/tmux DRIVER whose
          // process is still alive (server merely restarted / WS dropped) must
          // NOT be false-ended — it would vanish from the default list. Resolve
          // liveness from the messenger registry (UUID-join sessionId===id) +
          // kill -0 (the only ground-truth; heartbeat-freshness mis-calls quiet
          // drivers — C3). Scoped to pi/tmux ONLY: CC sessions are correctly
          // ended+hidden read-only views and are never resurrected. See
          // driver-liveness.ts for the full mechanism (Bert d20 dl-1744/1758).
          const liveness =
            hist.source !== "claude-code"
              ? resolveDriverLiveness(hist.id)
              : { alive: false as const };
          sessionManager.restore({
            id: hist.id,
            cwd: hist.cwd,
            // A live driver gets the registry's clean themed-name (e.g. "Don"),
            // overriding the stale session_info name; dead/CC keep the discovered name.
            name: liveness.alive && liveness.name ? liveness.name : hist.name,
            source: hist.source === "claude-code" ? "claude-code" : "tui",
            // Live driver → idle+visible (it is alive, just quiet); else ended+hidden.
            status: liveness.alive ? "idle" : "ended",
            startedAt: hist.startedAt,
            sessionFile: hist.sessionFile,
            sessionDir: hist.sessionDir,
            firstMessage: hist.firstMessage,
            hidden: liveness.alive ? false : true,
            dataUnavailable: true,
            model,
            contextTokens,
            contextWindow,
          });
          const session = sessionManager.get(hist.id);
          if (session) browserGateway.broadcastSessionAdded(session);
        }
      }
    }
  } catch (err) {
    console.error("[dashboard] Session discovery failed:", err);
  }

  // Start OpenSpec polling, broadcast changes to browsers
  directoryService.startPolling((cwd, data) => {
    browserGateway.broadcastToAll({
      type: "openspec_update",
      cwd,
      data,
    } as any);
  });

  // Initial OpenSpec poll for all known directories.
  //
  // Fire-and-forget: `refreshOpenSpec` / `pollOpenSpec` is synchronous internally
  // (spawnSync per change) — on Windows with many active changes and multiple
  // pinned directories this can block the event loop for minutes, making the
  // HTTP server unresponsive during startup. We intentionally do NOT await it
  // here so HTTP + WebSocket startup completes immediately.
  //
  // After each directory's poll completes, broadcast `openspec_update` to all
  // connected browsers if the prior cache was empty/undefined or the polled
  // data differs from prior — mirroring the proven `runPostInstallRepair`
  // pattern in `server.ts`. This is what unblocks cold-boot Electron clients
  // that connected before the cache was hot.
  //
  // A proper fix for the slow `spawnSync` path is to migrate the openspec
  // Recipe to async spawn; tracked separately. See change:
  // consolidate-tool-resolution. This change covers the broadcast wiring only.
  // See change: fix-cold-boot-openspec-protocol.
  void Promise.all(
    directoryService.knownDirectories().map(async (cwd) => {
      try {
        const prior = directoryService.getOpenSpecData(cwd);
        const fresh = await directoryService.refreshOpenSpec(cwd);
        const priorEmpty = isOpenSpecDataEmpty(prior);
        const dataDiffers = JSON.stringify(prior) !== JSON.stringify(fresh);
        if (priorEmpty || dataDiffers) {
          browserGateway.broadcastToAll({ type: "openspec_update", cwd, data: fresh });
        }
      } catch (err) {
        console.error(`[dashboard] initial openspec poll failed for ${cwd}:`, err);
      }
    }),
  );
}
