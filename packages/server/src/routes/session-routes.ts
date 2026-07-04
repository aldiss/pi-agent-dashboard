/**
 * Session-related REST API routes.
 */
import { readFile } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import type { FastifyInstance } from "fastify";
import type { SessionManager } from "../memory-session-manager.js";
import type { EventStore } from "../memory-event-store.js";
import type { ApiResponse } from "@blackbelt-technology/pi-dashboard-shared/types.js";
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
    /** Injected liveness I/O (registry kill-0 + record-pid + CC tmux-pane). */
    hygieneProbes: HygieneProbes;
    /** Broadcast a session_updated to all browsers (so the read-path reap is live). */
    broadcastSessionUpdated: (sessionId: string, updates: Record<string, unknown>) => void;
    /** Grace window (ms) before a verified-dead ended row is auto-retired. */
    hygieneGraceMs?: number;
    /** Injectable clock for tests. */
    now?: () => number;
  },
) {
  const {
    sessionManager,
    eventStore,
    networkGuard,
    hygieneProbes,
    broadcastSessionUpdated,
    hygieneGraceMs,
    now = Date.now,
  } = deps;

  // F1 (ghost-reap) + F2 (name-canonicalization) + F4 (CC-pane liveness) all
  // run HERE on the read-path — the gap the design diagnoses: liveness
  // resolution previously ran ONLY at restore/bootstrap, so dead rows lingered
  // and live-but-bridge-dropped rows false-ended. Reconcile is idempotent:
  // applies the canonical name / rescues a false-end / retires a verified-dead
  // aged-out ghost, then persists (via update→onChange) + broadcasts so live
  // browsers converge. NEVER hides a live row (invariant #1).
  fastify.get("/api/sessions", async () => {
    const actions = reconcileSessionHygiene(sessionManager.listAll(), hygieneProbes, {
      nowMs: now(),
      graceMs: hygieneGraceMs,
    });
    for (const a of actions) {
      sessionManager.update(a.sessionId, a.updates);
      broadcastSessionUpdated(a.sessionId, a.updates as Record<string, unknown>);
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
    { preHandler: networkGuard },
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
