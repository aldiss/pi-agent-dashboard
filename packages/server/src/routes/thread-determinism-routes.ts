/**
 * Thread-durability — read-only DETERMINISM projection REST route (dl-13423,
 * fixture-bound phase). Serves, per `thread_id`, the NOS determinism-model
 * `project(thread_id)` fold — the `stage` + deterministic-vs-judgment `pending`
 * edges the ThreadsView determinism overlay renders.
 *
 * FIXTURE-BACKED for this phase: the projection is served from the FROZEN
 * extracted fixture (`_fixture/fixture-c23c8d47.json`) via the shared loader —
 * there is NO live ledger read, NO fold execution, NO coupling to the model
 * source tree. This is the deliberate zero-coupling posture (dl-13481): bind the
 * render surface against a frozen sample first; live wiring is a separate Joan
 * decision, out of scope here.
 *
 * READ-ONLY and, like `thread-view-routes.ts`, NOT wired into `server.ts` yet —
 * it exists + is unit-tested (held activation). Matches the repo route
 * conventions (Fastify, `networkGuard` preHandler, `{success,data}`
 * `ApiResponse`, 400 on missing param). An unknown thread is NOT a 404: it
 * resolves to a `degrade:"unmapped"` projection (200) — the honest "not in the
 * machine yet" answer, never an error.
 */
import type { FastifyInstance } from "fastify";
import type { ApiResponse } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import type { NetworkGuard } from "./route-deps.js";
import type { DeterminismProjection } from "@blackbelt-technology/pi-dashboard-shared/thread-durability/tier1/determinism-projection.js";
import { makeFixtureDeterminismFetcher } from "@blackbelt-technology/pi-dashboard-shared/thread-durability/tier1/determinism-fixture.js";

/** The per-thread determinism payload the overlay renders. */
export interface ThreadDeterminismData {
  thread_id: string;
  projection: DeterminismProjection;
}

/**
 * A projection resolver: `threadId → its projection`. Fixture-backed by default
 * (the frozen sample loader); injectable so the unit test can supply a fixture
 * fetcher over a temp file without reading the real bind target. Always resolves
 * (unknown → unmapped) — never throws, never null.
 */
export type DeterminismResolver = (threadId: string) => Promise<DeterminismProjection>;

export function registerThreadDeterminismRoutes(
  fastify: FastifyInstance,
  deps: {
    networkGuard: NetworkGuard;
    /** Defaults to the frozen-fixture-backed resolver (this phase). */
    resolve?: DeterminismResolver;
  },
) {
  const { networkGuard } = deps;
  // Build the fixture-backed resolver ONCE at registration (eager fixture load,
  // indexed) unless the caller injects one (the unit test does).
  const resolve: DeterminismResolver = deps.resolve ?? makeFixtureDeterminismFetcher();

  // GET /api/threads/:threadId/determinism — the per-thread determinism
  // projection (stage + pending edges). Read-only, fixture-backed (no live fold).
  fastify.get<{ Params: { threadId: string } }>(
    "/api/threads/:threadId/determinism",
    { preHandler: networkGuard },
    async (request, reply) => {
      const threadId = request.params.threadId;
      if (!threadId) {
        reply.code(400);
        return { success: false, error: "threadId param required" } satisfies ApiResponse;
      }
      const projection = await resolve(threadId);
      return {
        success: true,
        data: { thread_id: threadId, projection } satisfies ThreadDeterminismData,
      } satisfies ApiResponse;
    },
  );
}
