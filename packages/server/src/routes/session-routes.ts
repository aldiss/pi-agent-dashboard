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
import { makeRestSessionGate } from "../rest-session-gate.js";
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
    /**
     * Build 1b (C-REST-CLOSURE): startup-frozen multi-operator gate flag +
     * operator identities. `POST /api/sessions/retire` is a session-WRITE
     * (hides rows) → gated `operator-only` through the SAME central chokepoint.
     * Default false → the gate no-ops (byte-unchanged).
     */
    requireBrowserAuth?: boolean;
    operatorUsers?: string[];
  },
) {
  const { sessionManager, eventStore, networkGuard, hygieneProbes, broadcastSessionUpdated } = deps;
  const nowFn = deps.now ?? (() => Date.now());
  const hygieneGraceMs = deps.hygieneGraceMs ?? 0;

  // Build 1b: the retire route's operator-only session-write gate. Runs AFTER
  // networkGuard (Fastify runs a preHandler array in order) so a non-loopback
  // unauthenticated caller is still 403'd by the network guard first; the
  // session-write gate then enforces operator-only when the flag is on.
  const gate = makeRestSessionGate({
    requireBrowserAuth: deps.requireBrowserAuth === true,
    ...(deps.operatorUsers ? { operatorUsers: deps.operatorUsers } : {}),
  });

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

  // POST /api/sessions/retire — the reaper consumer endpoint (AutoHandoffDriver
  // commit 07add54). Multi-key body {sessionId|tmuxName|pid}; server resolves
  // from the in-memory record (name+pid, NO JSONL read — race-free).
  //
  // ★ Joan's load-bearing guard (invariant #1 + #4) ★: the server INDEPENDENTLY
  // verifies-dead via the explicit liveness predicate before retiring. A target
  // that proves LIVE is REFUSED and surfaced as an anomaly (retire-requested-
  // on-a-LIVE-session = split-brain / cross-fork, the dl-2939 ×4 incident) —
  // its row stays live-visible, NEVER hidden. Best-effort + non-fatal: always
  // HTTP 200 so a retire-miss never breaks the reaper (the reap already
  // succeeded; the F1 read-path kill-0 backstop covers any miss next scan).
  fastify.post<{ Body: RetireKey }>(
    "/api/sessions/retire",
    { preHandler: [networkGuard, gate("retire")] },
    async (request) => {
      const body = (request.body ?? {}) as RetireKey;
      const key: RetireKey = {
        sessionId: typeof body.sessionId === "string" ? body.sessionId : undefined,
        tmuxName: typeof body.tmuxName === "string" ? body.tmuxName : undefined,
        pid: typeof body.pid === "number" ? body.pid : undefined,
      };
      if (!key.sessionId && !key.tmuxName && key.pid === undefined) {
        return {
          success: false,
          error: "retire requires one of {sessionId, tmuxName, pid}",
        } satisfies ApiResponse;
      }

      const decision = evaluateRetire(sessionManager.listAll(), key, hygieneProbes);

      // Retire (hidden-not-deleted) the proven-dead targets + broadcast.
      for (const sessionId of decision.retired) {
        sessionManager.update(sessionId, { hidden: true });
        broadcastSessionUpdated(sessionId, { hidden: true });
      }

      // Invariant #1 anomaly: a retire was requested on a LIVE row. We refused
      // to hide it; log it loud so the split-brain/cross-fork is visible.
      if (decision.anomaly) {
        for (const r of decision.refusedLive) {
          console.warn(
            `[dashboard] retire REFUSED — target is LIVE (${r.reason}); ` +
              `leaving row visible (anomaly: split-brain/cross-fork). ` +
              `sessionId=${r.sessionId || "<unmatched>"} name=${r.name ?? "?"} ` +
              `key=${JSON.stringify(key)}`,
          );
        }
      }

      return {
        success: true,
        data: {
          retired: decision.retired,
          refusedLive: decision.refusedLive,
          notFound: decision.notFound,
          anomaly: decision.anomaly,
        },
      } satisfies ApiResponse;
    },
  );

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
