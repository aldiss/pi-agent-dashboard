/**
 * Session-related REST API routes.
 */
import { readFile } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import type { FastifyInstance } from "fastify";
import type { SessionManager } from "../memory-session-manager.js";
import type { EventStore } from "../memory-event-store.js";
import type { ApiResponse, DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import type { NetworkGuard } from "./route-deps.js";
import { extractFileChanges, enrichWithGitDiff } from "../session-diff.js";
import {
  reconcileSessionHygiene,
  evaluateRetire,
  type HygieneProbes,
  type RetireKey,
} from "../session-hygiene.js";

export function registerSessionRoutes(
  fastify: FastifyInstance,
  deps: {
    sessionManager: SessionManager;
    eventStore: EventStore;
    networkGuard: NetworkGuard;
    /** Injected liveness probes for read-path hygiene + the retire guard. */
    hygieneProbes: HygieneProbes;
    /** Broadcast a per-session update to subscribed browsers. */
    broadcastSessionUpdated: (id: string, updates: Partial<DashboardSession>) => void;
    /** Per-session quiet window before a verified-dead row is reaped/demoted. */
    hygieneGraceMs?: number;
    /** Injected clock (tests). */
    now?: () => number;
  },
) {
  const { sessionManager, eventStore, networkGuard, hygieneProbes, broadcastSessionUpdated } = deps;
  const nowFn = deps.now ?? (() => Date.now());
  const hygieneGraceMs = deps.hygieneGraceMs ?? 0;

  // GET /api/sessions — read-path hygiene (F1 reap + demote, F2 name-canon,
  // false-ended rescue) via reconcileSessionHygiene, then return the reconciled
  // list. Each action is applied to the in-memory manager AND broadcast so both
  // the responding fetch and live subscribers converge. (The cadence sweep in
  // server.ts runs the same reconcile on a timer with the post-restart grace.)
  fastify.get("/api/sessions", async () => {
    const actions = reconcileSessionHygiene(sessionManager.listAll(), hygieneProbes, {
      nowMs: nowFn(),
      graceMs: hygieneGraceMs,
    });
    for (const a of actions) {
      sessionManager.update(a.sessionId, a.updates);
      broadcastSessionUpdated(a.sessionId, a.updates);
    }
    return { success: true, data: sessionManager.listAll() } satisfies ApiResponse;
  });

  // POST /api/sessions/retire — proactively hide a proven-dead row (F1 retire).
  // The load-bearing guard: evaluateRetire NEVER trusts the caller's dead-claim —
  // it independently verifies each target dead; a live (or live-key) target is
  // REFUSED and surfaced as an anomaly (invariant #1), its row left visible.
  fastify.post<{ Body: RetireKey }>("/api/sessions/retire", async (request) => {
    const body = request.body ?? {};
    const hasKey = !!body.sessionId || !!body.tmuxName || typeof body.pid === "number";
    if (!hasKey) {
      return { success: false, error: "retire requires sessionId, tmuxName, or pid" } satisfies ApiResponse;
    }
    const decision = evaluateRetire(sessionManager.listAll(), body, hygieneProbes);
    for (const id of decision.retired) {
      sessionManager.update(id, { hidden: true });
      broadcastSessionUpdated(id, { hidden: true });
    }
    return {
      success: true,
      data: {
        retired: decision.retired,
        refusedLive: decision.refusedLive,
        anomaly: decision.anomaly,
        notFound: decision.notFound,
      },
    } satisfies ApiResponse;
  });

  fastify.get<{ Params: { sessionId: string; seq: string } }>(
    "/api/events/:sessionId/:seq",
    async (request) => {
      const { sessionId, seq } = request.params;
      const event = eventStore.getEvent(sessionId, parseInt(seq, 10));
      if (!event) {
        return { success: false, error: "Event not found" } satisfies ApiResponse;
      }
      return { success: true, data: event } satisfies ApiResponse;
    },
  );

  // Session file diff endpoint (localhost-only)
  fastify.get<{ Querystring: { sessionId?: string } }>(
    "/api/session-diff",
    { preHandler: networkGuard },
    async (request) => {
      const { sessionId } = request.query;
      if (!sessionId) {
        return { success: false, error: "sessionId required" } satisfies ApiResponse;
      }
      const session = sessionManager.get(sessionId);
      if (!session) {
        return { success: false, error: "session not found" } satisfies ApiResponse;
      }
      const events = eventStore.getEvents(sessionId, 0).map((e) => e.event);
      const files = extractFileChanges(events, session.cwd);
      const result = enrichWithGitDiff(session.cwd, files);
      return {
        success: true,
        data: {
          files: result.enrichedFiles,
          isGitRepo: result.isGitRepo,
        },
      } satisfies ApiResponse;
    },
  );

  // Read a file within a session's cwd (localhost-only)
  fastify.get<{ Querystring: { sessionId?: string; path?: string } }>(
    "/api/session-file",
    { preHandler: networkGuard },
    async (request, reply) => {
      const { sessionId, path: filePath } = request.query;
      if (!sessionId || !filePath) {
        reply.code(400);
        return { success: false, error: "sessionId and path required" } satisfies ApiResponse;
      }
      const session = sessionManager.get(sessionId);
      if (!session) {
        reply.code(404);
        return { success: false, error: "session not found" } satisfies ApiResponse;
      }
      // Resolve and ensure path is within cwd
      const absPath = isAbsolute(filePath) ? filePath : resolve(session.cwd, filePath);
      const rel = relative(session.cwd, absPath);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        reply.code(403);
        return { success: false, error: "path outside session directory" } satisfies ApiResponse;
      }
      try {
        const content = await readFile(absPath, "utf-8");
        return { success: true, data: { content } } satisfies ApiResponse;
      } catch {
        reply.code(404);
        return { success: false, error: "file not found" } satisfies ApiResponse;
      }
    },
  );
}
