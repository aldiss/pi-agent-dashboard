/**
 * External-session REST routes (read-only).
 *
 * Mirrors `routes/surfaces-routes.ts` for auth/guard shape: every route is
 * `preHandler: networkGuard`, handlers never throw (graceful degradation).
 * There is NO input path here — no POST/PUT/DELETE, no send/abort/kill. The
 * surface is view-only by construction.
 *
 *   GET /api/external-sessions            → { sessions, owners, drivers }
 *   GET /api/external-sessions/:id/capture → { id, output, lineCount, state, capturedAt }
 *                                            (fresh larger read when live;
 *                                             frozen output when ended)
 *   GET /api/external-sessions/:id/transcript → normalized read-only timeline
 */
import type { FastifyInstance } from "fastify";
import type { ExternalSessionsResponse } from "@blackbelt-technology/pi-dashboard-shared/external-session.js";
import {
  driverRegistry as defaultDriverRegistry,
  type DriverRegistry,
} from "../../driver-registry.js";
import type { NetworkGuard } from "../../routes/route-deps.js";
import {
  createExternalSessionOwnersReader,
  type ExternalSessionOwnersReader,
} from "../owners-reader.js";
import type { ExternalSessionRegistry } from "../scanner.js";
import {
  createExternalSessionTranscriptReader,
  type ExternalSessionTranscriptReader,
} from "../transcript-reader.js";

export function registerExternalSessionRoutes(
  fastify: FastifyInstance,
  deps: {
    registry: ExternalSessionRegistry;
    networkGuard: NetworkGuard;
    transcriptReader?: Pick<ExternalSessionTranscriptReader, "read">;
    ownersReader?: Pick<ExternalSessionOwnersReader, "getOwners">;
    driverRegistry?: Pick<DriverRegistry, "getCellDrivers">;
  },
): void {
  const { registry, networkGuard } = deps;
  const transcriptReader = deps.transcriptReader ?? createExternalSessionTranscriptReader();
  const ownersReader = deps.ownersReader ?? createExternalSessionOwnersReader();
  const driverRegistry = deps.driverRegistry ?? defaultDriverRegistry;

  fastify.get(
    "/api/external-sessions",
    { preHandler: networkGuard },
    async (_request, _reply): Promise<ExternalSessionsResponse> => {
      return {
        sessions: registry.list(),
        owners: ownersReader.getOwners(),
        drivers: driverRegistry.getCellDrivers(),
      };
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

  fastify.get<{ Params: { id: string } }>(
    "/api/external-sessions/:id/transcript",
    { preHandler: networkGuard },
    async (request, reply) => {
      const { id } = request.params;
      const session = registry.list().find((candidate) => candidate.id === id);
      if (!session) {
        reply.code(404);
        return { error: `unknown external session: ${id}` };
      }
      try {
        return await transcriptReader.read(session);
      } catch {
        return { id, source: "capture" as const, entries: [], truncated: false };
      }
    },
  );
}
