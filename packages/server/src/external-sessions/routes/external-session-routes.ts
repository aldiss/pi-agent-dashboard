/**
 * External-session REST routes (read-only).
 *
 * Mirrors `routes/surfaces-routes.ts` for auth/guard shape: every route is
 * `preHandler: networkGuard`, handlers never throw (graceful degradation).
 * There is NO input path here — no POST/PUT/DELETE, no send/abort/kill. The
 * surface is view-only by construction.
 *
 *   GET /api/external-sessions            → { sessions: ExternalSession[] }
 *   GET /api/external-sessions/:id/capture → { id, output, lineCount, state, capturedAt }
 *                                            (fresh larger read when live;
 *                                             frozen output when ended)
 */
import type { FastifyInstance } from "fastify";
import type { NetworkGuard } from "../../routes/route-deps.js";
import type { ExternalSessionRegistry } from "../scanner.js";

export function registerExternalSessionRoutes(
  fastify: FastifyInstance,
  deps: { registry: ExternalSessionRegistry; networkGuard: NetworkGuard },
): void {
  const { registry, networkGuard } = deps;

  fastify.get(
    "/api/external-sessions",
    { preHandler: networkGuard },
    async (_request, _reply) => {
      return { sessions: registry.list() };
    },
  );

  fastify.get<{ Params: { id: string } }>(
    "/api/external-sessions/:id/capture",
    { preHandler: networkGuard },
    async (request, reply) => {
      const { id } = request.params;
      const result = registry.captureOne(id);
      if (!result) {
        reply.code(404);
        return { error: `unknown external session: ${id}` };
      }
      return result;
    },
  );
}
