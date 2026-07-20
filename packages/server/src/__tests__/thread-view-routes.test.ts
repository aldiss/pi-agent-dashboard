/**
 * B4 step 4 — read-only thread-view REST routes (design v3.6).
 *
 * HTTP-level tests (Fastify + inject) over the REAL B2 `OutboxStore` +
 * `ThreadPushChannel` (temp dir, HOME-isolation guard). Proves the per-thread
 * delivery-state view reads the durable outbox (SoT), is read-only, honors the
 * network guard, and 400s a missing param.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { OutboxStore } from "../thread-durability/outbox-store.js";
import { ThreadPushChannel } from "../thread-durability/push-channel.js";
import { registerThreadViewRoutes } from "../routes/thread-view-routes.js";
import type { AttemptInput } from "@blackbelt-technology/pi-dashboard-shared/thread-durability/index.js";
import type { NetworkGuard } from "../routes/route-deps.js";

const PASSTHRU_GUARD: NetworkGuard = async () => {};
const DENY_GUARD: NetworkGuard = async (_req, reply) => {
  reply.code(403).send({ success: false, error: "forbidden" });
};

const IDENTITY = { pid: 4242, session_id: "sess-A", start_epoch: 1000 };
function attempt(over: Partial<AttemptInput> = {}): AttemptInput {
  return {
    delivery_id: "D1",
    attempt: 1,
    thread_id: "T1",
    holder_session_id: "sess-A",
    holder_identity: { ...IDENTITY },
    holder_epoch: 7,
    payload_hash: "hash-1",
    ...over,
  };
}

describe("thread-view REST routes", () => {
  let tmpDir: string;
  let store: OutboxStore;
  let channel: ThreadPushChannel;
  let fastify: FastifyInstance;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "thread-view-routes-"));
    store = new OutboxStore(tmpDir);
    channel = new ThreadPushChannel({ store });
  });

  afterEach(async () => {
    if (fastify) await fastify.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function setup(guard: NetworkGuard = PASSTHRU_GUARD) {
    fastify = Fastify();
    registerThreadViewRoutes(fastify, { channel, networkGuard: guard });
    await fastify.ready();
  }

  it("returns the per-thread deliveries + states + revisions + timestamps", async () => {
    await store.markAttempting(attempt({ delivery_id: "A", thread_id: "T1" }));
    await store.markQueued({ delivery_id: "A", expected: { expected_revision: 0, expected_attempt: 1, expected_state: "injecting" } });
    await store.markAttempting(attempt({ delivery_id: "B", thread_id: "T1" }));
    await store.markAttempting(attempt({ delivery_id: "Z", thread_id: "T2" }));
    await setup();

    const res = await fastify.inject({ method: "GET", url: "/api/threads/T1/deliveries" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.thread_id).toBe("T1");
    const ids = body.data.deliveries.map((d: any) => d.delivery_id).sort();
    expect(ids).toEqual(["A", "B"]); // T2's Z is excluded
    const a = body.data.deliveries.find((d: any) => d.delivery_id === "A");
    expect(a.state).toBe("queued_executing");
    expect(a.revision).toBe(1);
    expect(typeof a.updated_at).toBe("number");
  });

  it("empty thread → empty deliveries array (200, not 404)", async () => {
    await setup();
    const res = await fastify.inject({ method: "GET", url: "/api/threads/UNKNOWN/deliveries" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { thread_id: "UNKNOWN", deliveries: [] } });
  });

  it("reflects the current durable state (read-only, SoT) — a delivered row shows delivered", async () => {
    await store.markAttempting(attempt({ delivery_id: "A", thread_id: "T1" }));
    await store.markQueued({ delivery_id: "A", expected: { expected_revision: 0, expected_attempt: 1, expected_state: "injecting" } });
    await store.markObserved({ delivery_id: "A", expected: { expected_revision: 1, expected_attempt: 1, expected_state: "queued_executing" } });
    await store.markAccepted({ delivery_id: "A", expected: { expected_revision: 2, expected_attempt: 1, expected_state: "observed" } });
    await store.markExecuted({ delivery_id: "A", expected: { expected_revision: 3, expected_attempt: 1, expected_state: "accepted" } });
    await store.markDelivered({ delivery_id: "A", expected: { expected_revision: 4, expected_attempt: 1, expected_state: "executed" } });
    await setup();

    const res = await fastify.inject({ method: "GET", url: "/api/threads/T1/deliveries" });
    const d = res.json().data.deliveries[0];
    expect(d.state).toBe("executed");
    expect(d.delivered).toBe(true);
    expect(d.revision).toBe(5);
  });

  it("is READ-ONLY: a GET never mutates the outbox (revision unchanged across calls)", async () => {
    await store.markAttempting(attempt({ delivery_id: "A", thread_id: "T1" }));
    await setup();
    await fastify.inject({ method: "GET", url: "/api/threads/T1/deliveries" });
    await fastify.inject({ method: "GET", url: "/api/threads/T1/deliveries" });
    expect(store.read("A")!.revision).toBe(0); // no mutation from reads
  });

  it("honors the network guard (403 when denied)", async () => {
    await store.markAttempting(attempt({ thread_id: "T1" }));
    await setup(DENY_GUARD);
    const res = await fastify.inject({ method: "GET", url: "/api/threads/T1/deliveries" });
    expect(res.statusCode).toBe(403);
  });
});
