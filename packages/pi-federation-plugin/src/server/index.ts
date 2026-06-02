/**
 * Federation plugin — server entry.
 *
 * Composes:
 *   - PeerConnection per configured peer (WebSocket-over-Tailscale + reconnect/backoff + auth handshake)
 *   - mDNS LAN-shortcut layer (option C composed; prefers same-LAN address when discovered)
 *   - Mesh-bridge: every peer event is re-broadcast to local browsers with
 *     machineId-prefixed session ids (so the browser sees federated sessions
 *     side-by-side with local ones, no id collisions possible)
 *   - REST routes /api/federation/{peers,sessions,health}
 *
 * Per Schema 7 §3.5 + investigator #1 §6.3 federation-hook sketch.
 *
 * The plugin's responsibility: route peer-side events into the local server's
 * broadcast channel. The control-inverse (browser sends prompt for federated
 * session id → strip prefix → forward to peer) is intentionally OUT OF SCOPE
 * for v0.1 — pi-agent-dashboard's browser-handlers route by sessionId at
 * server-receive time before plugin can intercept (would require core router
 * changes in browser-gateway.ts, which the bounded-engineering scope per
 * operator-direct 2026-05-14 ~09:35 CEST explicitly forbids). v0.2+ wires the
 * inverse via registerBrowserHandler stub once the core router exposes a
 * passthrough hook.
 *
 * v0.1 ships read-only federation: operator sees peer sessions in the local
 * dashboard's session list; control still requires switching to the peer
 * server via the existing ServerSelector. This is intentional safety
 * (compromised local browser cannot accidentally control a remote machine)
 * and is the same posture investigator #1 §6.5 recommends.
 */

import type { ServerPluginContext } from "./types.js";
import type { PeerConfig } from "./peer-connection.js";
import { PeerConnection, mintFederationJwt, type PeerMessage } from "./peer-connection.js";
import { createLanDiscovery, preferredLanHost } from "./mdns-shortcut.js";
import { registerFederationRoutes } from "./routes.js";

interface FederationConfig {
  enabled?: boolean;
  machineId?: string;
  peers?: PeerConfig[];
  discoverLan?: boolean;
  authMode?: "loopback-trusted-networks" | "shared-secret-jwt";
  sharedAuthSecret?: string;
  reconnectInitialMs?: number;
  reconnectMaxMs?: number;
  watchdogTimeoutMs?: number;
}

const DEFAULTS: Required<FederationConfig> = {
  // Default true preserves existing behavior for installations that never set
  // the flag. Operators opt out by setting plugins.federation.enabled=false.
  enabled: true,
  machineId: "",
  peers: [],
  discoverLan: true,
  authMode: "loopback-trusted-networks",
  sharedAuthSecret: "",
  reconnectInitialMs: 1000,
  reconnectMaxMs: 30_000,
  watchdogTimeoutMs: 60_000,
};

const PLUGIN_VERSION = "0.4.7";

function resolveConfig(raw: FederationConfig): Required<FederationConfig> {
  return {
    enabled: raw.enabled ?? DEFAULTS.enabled,
    machineId: raw.machineId ?? DEFAULTS.machineId,
    peers: Array.isArray(raw.peers) ? raw.peers : DEFAULTS.peers,
    discoverLan: raw.discoverLan ?? DEFAULTS.discoverLan,
    authMode: raw.authMode ?? DEFAULTS.authMode,
    sharedAuthSecret: raw.sharedAuthSecret ?? DEFAULTS.sharedAuthSecret,
    reconnectInitialMs: raw.reconnectInitialMs ?? DEFAULTS.reconnectInitialMs,
    reconnectMaxMs: raw.reconnectMaxMs ?? DEFAULTS.reconnectMaxMs,
    watchdogTimeoutMs: raw.watchdogTimeoutMs ?? DEFAULTS.watchdogTimeoutMs,
  };
}

interface State {
  cfg: Required<FederationConfig>;
  peers: Map<string, PeerConnection>;
  startedAt: number;
}

/**
 * Re-broadcast a peer message to local browsers, prefixing every session id
 * with the peer's machineId so the browser sees `imac:abc123` not `abc123`.
 *
 * The peer's protocol uses several places where `sessionId` may appear; we
 * deep-rewrite known fields. Unknown messages flow through with only the
 * top-level wrapper applied.
 */
function rebroadcastWithPrefix(
  ctx: ServerPluginContext,
  machineId: string,
  msg: PeerMessage,
): void {
  if (typeof ctx.broadcastToSubscribers !== "function") return;

  // Wrap unconditionally so the local browser knows it came from federation
  // (even if the inner message has no sessionId — e.g. servers_discovered).
  // The local browser-side plugin client unwraps `original` to get the raw
  // message + uses `machineId` to render badges.
  const wrapped = {
    type: "federation_event",
    machineId,
    pluginVersion: PLUGIN_VERSION,
    receivedAt: Date.now(),
    original: prefixIds(msg, machineId),
  } as unknown;

  try {
    ctx.broadcastToSubscribers(wrapped);
  } catch (err) {
    ctx.logger.warn(
      `broadcast failed (msg.type=${msg.type}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Recursively prefix sessionId / session.id fields with `${machineId}:` so
 * the browser sees globally-unique federated ids. Non-id fields are
 * pass-through.
 *
 * Cycle + depth defense: the original implementation had no cycle detection
 * and no depth limit, so a peer payload containing a circular reference (or
 * a deeply-nested-but-acyclic graph) blew the V8 call stack with
 * `RangeError: Maximum call stack size exceeded`. The crash was swallowed by
 * the dashboard's [crash-safety] handler but corrupted in-flight state,
 * causing browsers to disconnect/reconnect in a tight loop. The fix:
 *   1. WeakSet `seen` aborts revisits of already-rewritten object/array
 *      references (returns the value unchanged — id rewrite is idempotent
 *      enough that the second visit being a no-op is safe).
 *   2. Hard `PREFIX_IDS_MAX_DEPTH` floor catches non-circular but absurdly
 *      deep graphs that a malicious or buggy peer could send.
 */
/** Hard depth cap for {@link prefixIds} recursion (defense-in-depth). */
export const PREFIX_IDS_MAX_DEPTH = 256;

function prefixIds<T>(
  value: T,
  machineId: string,
  seen?: WeakSet<object>,
  depth = 0,
): T {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (depth >= PREFIX_IDS_MAX_DEPTH) return value;

  const obj = value as unknown as object;
  const visited = seen ?? new WeakSet<object>();
  if (visited.has(obj)) return value;
  visited.add(obj);

  if (Array.isArray(value)) {
    return value.map(v => prefixIds(v, machineId, visited, depth + 1)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === "sessionId" && typeof v === "string" && !v.includes(":")) {
      out[k] = `${machineId}:${v}`;
    } else if (k === "id" && typeof v === "string" && isLikelySessionId(v)) {
      out[k] = `${machineId}:${v}`;
    } else {
      out[k] = prefixIds(v, machineId, visited, depth + 1);
    }
  }
  return out as T;
}

/**
 * Heuristic: pi session ids are UUID-like (8-4-4-4-12 hex segments). Avoid
 * prefixing arbitrary `id` fields that aren't session ids.
 */
function isLikelySessionId(v: string): boolean {
  return /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(v);
}

/**
 * Internal helpers exported solely for unit testing the bug-fixes:
 *   - prefixIds cycle-detect + depth-limit (regression for peer-payload
 *     `RangeError: Maximum call stack size exceeded` crash-loop)
 *   - resolveConfig defaulting (regression for `enabled` flag honor)
 *
 * Production code should not import these directly.
 */
export const __internal = {
  prefixIds: <T>(value: T, machineId: string): T => prefixIds(value, machineId),
  resolveConfig: (raw: Record<string, unknown>) => resolveConfig(raw as FederationConfig),
};

export default async function registerPlugin(ctx: ServerPluginContext): Promise<void> {
  const rawConfig = (ctx.getPluginConfig?.() as FederationConfig | undefined) ?? {};
  const cfg = resolveConfig(rawConfig);

  // Honor the operator-config `enabled` flag. Prior versions of this plugin
  // ignored the flag entirely: peer connections were opened, the mDNS
  // discovery layer ran, and REST routes were registered regardless of the
  // user's stated intent. Operators who set `plugins.federation.enabled=false`
  // to silence a cross-machine peer storm correctly discovered the storm
  // continued unabated. We now short-circuit cleanly when disabled.
  if (cfg.enabled === false) {
    ctx.logger.info(
      `federation plugin v${PLUGIN_VERSION} disabled via config (plugins.federation.enabled=false); ` +
        `skipping peer connections, mDNS discovery, and REST route registration`,
    );
    return;
  }

  ctx.logger.info(
    `federation plugin v${PLUGIN_VERSION} activate; ` +
      `machineId=${cfg.machineId || "<auto>"} peers=${cfg.peers.length} ` +
      `discoverLan=${cfg.discoverLan} authMode=${cfg.authMode}`,
  );

  const state: State = {
    cfg,
    peers: new Map(),
    startedAt: Date.now(),
  };

  // Register REST routes BEFORE creating peer connections so /api/federation/peers
  // works even before peers come up.
  registerFederationRoutes(ctx.fastify, {
    peers: () => state.peers,
    pluginVersion: PLUGIN_VERSION,
    startedAt: state.startedAt,
  });

  // Mint JWT cookie if shared-secret-jwt mode + secret configured.
  let jwtCookieValue: string | undefined;
  if (cfg.authMode === "shared-secret-jwt" && cfg.sharedAuthSecret) {
    try {
      jwtCookieValue = mintFederationJwt(
        cfg.sharedAuthSecret,
        cfg.machineId || "unknown",
      );
      ctx.logger.info("federation JWT minted (shared-secret-jwt mode active)");
    } catch (err) {
      ctx.logger.error(
        `JWT mint failed; falling back to trusted-network bypass: ${err instanceof Error ? err.message : String(err)}`,
      );
      jwtCookieValue = undefined;
    }
  } else if (cfg.authMode === "shared-secret-jwt") {
    ctx.logger.warn(
      "authMode=shared-secret-jwt but sharedAuthSecret is empty; using trusted-network bypass instead",
    );
  }

  // Boot peer connections.
  for (const peer of cfg.peers) {
    if (!peer.host || !peer.port || !peer.machineId) {
      ctx.logger.warn(`peer skipped (missing host/port/machineId): ${JSON.stringify(peer)}`);
      continue;
    }
    const conn = new PeerConnection(peer, {
      logger: ctx.logger,
      reconnectInitialMs: cfg.reconnectInitialMs,
      reconnectMaxMs: cfg.reconnectMaxMs,
      watchdogTimeoutMs: cfg.watchdogTimeoutMs,
      ...(jwtCookieValue ? { jwtCookieValue } : {}),
      onMessage: (peerCfg, msg) => {
        rebroadcastWithPrefix(ctx, peerCfg.machineId, msg);
      },
      onStateChange: (peerCfg, st) => {
        // Surface connection-state-changed events to local browsers so the
        // settings panel + sidebar can show live indicators.
        if (typeof ctx.broadcastToSubscribers === "function") {
          try {
            ctx.broadcastToSubscribers({
              type: "federation_peer_state",
              machineId: peerCfg.machineId,
              host: peerCfg.host,
              port: peerCfg.port,
              state: st,
              at: Date.now(),
            } as unknown);
          } catch { /* ignore */ }
        }
      },
    });
    state.peers.set(peer.machineId, conn);
    conn.start();
  }

  // mDNS LAN-shortcut layer.
  let lanDisc: ReturnType<typeof createLanDiscovery> | null = null;
  if (cfg.discoverLan) {
    lanDisc = createLanDiscovery({
      logger: ctx.logger,
      onPeerUp: (svc) => {
        // Match against configured peers by port; if we find a LAN-shortcut
        // address that differs from the configured Tailscale IP, switch.
        for (const conn of state.peers.values()) {
          const lanHost = preferredLanHost(svc, conn.peer.port);
          if (lanHost && lanHost !== conn.getEffectiveHost()) {
            conn.setEffectiveHost(lanHost);
          }
        }
      },
      onPeerDown: (svc) => {
        // If a previously-discovered LAN peer goes down, revert to the
        // configured Tailscale IP for any peer currently using it.
        for (const conn of state.peers.values()) {
          if (svc.port !== conn.peer.port) continue;
          if (svc.addresses?.includes(conn.getEffectiveHost())) {
            conn.setEffectiveHost(conn.peer.host);
          }
        }
      },
    });
    lanDisc.start();
  }

  // Cleanup on shutdown.
  ctx.fastify.addHook("onClose", async () => {
    ctx.logger.info("federation plugin shutting down");
    for (const conn of state.peers.values()) conn.shutdown();
    state.peers.clear();
    lanDisc?.stop();
  });

  // Process-level termination safety.
  const onTerm = () => {
    for (const conn of state.peers.values()) conn.shutdown();
    lanDisc?.stop();
  };
  process.once("SIGTERM", onTerm);
  process.once("SIGINT", onTerm);

  ctx.logger.info(
    `federation plugin ready; ${state.peers.size} peer connection(s) initiated, REST routes /api/federation/{peers,sessions,health} live`,
  );
}
