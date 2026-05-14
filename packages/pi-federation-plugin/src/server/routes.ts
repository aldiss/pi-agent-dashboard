/**
 * REST routes for the federation plugin.
 *
 * Exposes:
 *   GET  /api/federation/peers      — list of configured peers + connection state
 *   GET  /api/federation/sessions   — aggregated peer sessions (machineId-prefixed ids)
 *   GET  /api/federation/health     — plugin runtime health snapshot
 *
 * All routes inherit the dashboard's existing auth pipeline (Fastify-level
 * auth-plugin onRequest hook applies network-guard + JWT validation per
 * packages/server/src/auth-plugin.ts). No additional preHandler needed —
 * routes added via ctx.fastify.get() flow through the same auth as core
 * routes. See packages/voice-input-plugin/src/server/index.ts for the same
 * pattern reference.
 */

import type { FastifyInstance } from "fastify";
import type { PeerConnection } from "./peer-connection.js";

interface FederationApiPeer {
  host: string;
  effectiveHost: string;
  port: number;
  machineId: string;
  label?: string;
  state: string;
  knownSessionCount: number;
}

interface FederationApiSession {
  /** machineId-prefixed federated id (e.g. "imac:abc123") — globally unique */
  id: string;
  /** Original peer-side id (no prefix). */
  remoteId: string;
  machineId: string;
  /** Opaque pass-through of peer's session record. */
  session: unknown;
}

export interface FederationRouteDeps {
  peers: () => Map<string, PeerConnection>;
  pluginVersion: string;
  startedAt: number;
}

export function registerFederationRoutes(fastify: FastifyInstance, deps: FederationRouteDeps): void {
  fastify.get("/api/federation/peers", async () => {
    const out: FederationApiPeer[] = [];
    for (const conn of deps.peers().values()) {
      out.push({
        host: conn.peer.host,
        effectiveHost: conn.getEffectiveHost(),
        port: conn.peer.port,
        machineId: conn.peer.machineId,
        ...(conn.peer.label ? { label: conn.peer.label } : {}),
        state: conn.getState(),
        knownSessionCount: conn.getKnownSessions().size,
      });
    }
    return { success: true, data: out };
  });

  fastify.get("/api/federation/sessions", async () => {
    const out: FederationApiSession[] = [];
    for (const conn of deps.peers().values()) {
      for (const [remoteId, session] of conn.getKnownSessions().entries()) {
        out.push({
          id: `${conn.peer.machineId}:${remoteId}`,
          remoteId,
          machineId: conn.peer.machineId,
          session,
        });
      }
    }
    return { success: true, data: out };
  });

  fastify.get("/api/federation/health", async () => {
    const peers = Array.from(deps.peers().values());
    const peerCount = peers.length;
    const openCount = peers.filter(p => p.getState() === "open").length;
    return {
      success: true,
      data: {
        pluginVersion: deps.pluginVersion,
        startedAt: deps.startedAt,
        uptimeSec: Math.floor((Date.now() - deps.startedAt) / 1000),
        peerCount,
        openCount,
        // Health summary intentionally compact; details via /api/federation/peers.
        healthy: peerCount === 0 ? true : openCount > 0,
      },
    };
  });
}
