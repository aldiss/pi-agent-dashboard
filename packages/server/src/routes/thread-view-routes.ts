/**
 * Thread-durability — read-only thread-view REST routes (design v3.6; B4
 * step 4). Returns, per `thread_id`, the durable outbox deliveries + their
 * states + revisions + timestamps for the B5 thread-view UI.
 *
 * READ-ONLY: the durable outbox is the source of truth; these routes NEVER
 * mutate it (no drain, no inject, no reconcile — the held routing stays held).
 * Matches the repo route conventions (Fastify, `networkGuard` preHandler,
 * `{success,data}` `ApiResponse`, 400 on missing params).
 */
import type { FastifyInstance } from "fastify";
import type { ApiResponse } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import type { NetworkGuard } from "./route-deps.js";
import type { ThreadPushChannel } from "../thread-durability/push-channel.js";
import type { ThreadDeliverySnapshot } from "@blackbelt-technology/pi-dashboard-shared/thread-durability/index.js";

/** The per-thread view payload the UI renders. */
export interface ThreadViewData {
  thread_id: string;
  deliveries: ThreadDeliverySnapshot[];
}

export function registerThreadViewRoutes(
  fastify: FastifyInstance,
  deps: {
    channel: ThreadPushChannel;
    networkGuard: NetworkGuard;
  },
) {
  const { channel, networkGuard } = deps;

  // GET /api/threads/:threadId/deliveries — the per-thread delivery-state view.
  // Read-only snapshot straight from the durable outbox (SoT). Also the REST
  // fallback for the A5 push channel when the push transport is unavailable.
  fastify.get<{ Params: { threadId: string } }>(
    "/api/threads/:threadId/deliveries",
    { preHandler: networkGuard },
    async (request, reply) => {
      const threadId = request.params.threadId;
      if (!threadId) {
        reply.code(400);
        return { success: false, error: "threadId param required" } satisfies ApiResponse;
      }
      const deliveries = channel.snapshotForThread(threadId);
      return {
        success: true,
        data: { thread_id: threadId, deliveries } satisfies ThreadViewData,
      } satisfies ApiResponse;
    },
  );
}
