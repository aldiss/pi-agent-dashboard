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
import { isClaudeSessionFile, loadClaudeSessionWindow, CLAUDE_WINDOW } from "../claude-transcript-reader.js";
import { replayEntriesAsEvents } from "@blackbelt-technology/pi-dashboard-shared/state-replay.js";

export function registerSessionRoutes(
  fastify: FastifyInstance,
  deps: {
    sessionManager: SessionManager;
    eventStore: EventStore;
    networkGuard: NetworkGuard;
  },
) {
  const { sessionManager, eventStore, networkGuard } = deps;

  fastify.get("/api/sessions", async () => {
    const sessions = sessionManager.listAll();
    return { success: true, data: sessions } satisfies ApiResponse;
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

  // Claude-Code transcript backward-pager. Returns ONE byte-bounded window of a
  // CC session's history ENDING at `before` (exclusive; default = EOF/tail), as
  // browser events the client reducer already understands, plus the cursor for
  // the next (earlier) window. Lets "▲ Load earlier" walk a 50 MB CC log back to
  // its start without ever whole-reading it. Only CC sessions have a byte-paged
  // history (pi sessions ship whole-file on subscribe), so non-CC sessions are
  // rejected. See change: perf/cc-viewing-payload-fix (Track 2, Fix A).
  fastify.get<{ Params: { id: string }; Querystring: { before?: string; limit?: string } }>(
    "/api/session/:id/transcript",
    async (request, reply) => {
      const { id } = request.params;
      const session = sessionManager.get(id);
      if (!session) {
        reply.code(404);
        return { success: false, error: "session not found" } satisfies ApiResponse;
      }
      const sessionFile = session.sessionFile;
      if (!sessionFile || !isClaudeSessionFile(sessionFile)) {
        reply.code(400);
        return { success: false, error: "not a Claude-Code session" } satisfies ApiResponse;
      }
      // `before` defaults to EOF (the tail window) when omitted/invalid. `limit`
      // is clamped to [1, CLAUDE_WINDOW] so a caller can't force an unbounded read.
      const beforeRaw = request.query.before != null ? Number(request.query.before) : Number.POSITIVE_INFINITY;
      const before = Number.isFinite(beforeRaw) && beforeRaw >= 0 ? beforeRaw : Number.POSITIVE_INFINITY;
      const limitRaw = request.query.limit != null ? Number(request.query.limit) : CLAUDE_WINDOW;
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, CLAUDE_WINDOW) : CLAUDE_WINDOW;

      const { entries, nextBeforeOffset, atStart } = loadClaudeSessionWindow(sessionFile, before, limit);
      const events = replayEntriesAsEvents(id, entries, session.contextWindow).map((m) => m.event);
      return {
        success: true,
        data: { events, nextBeforeOffset, atStart },
      } satisfies ApiResponse;
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
