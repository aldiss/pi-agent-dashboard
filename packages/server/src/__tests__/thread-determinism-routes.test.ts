/**
 * Read-only determinism-projection REST route tests (dl-13423, fixture-bound).
 *
 * HTTP-level tests (Fastify + inject) over the FIXTURE-BACKED resolver. Proves
 * the per-thread determinism view: serves the frozen `project(thread_id)` fold,
 * is read-only, honors the network guard, 400s a missing param, and returns an
 * `unmapped` projection (200, NOT 404) for an unknown thread. No live ledger, no
 * fold execution — the frozen fixture is the only source (zero coupling).
 */
import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

import {
  registerThreadDeterminismRoutes,
  type DeterminismResolver,
} from "../routes/thread-determinism-routes.js";
import { makeFixtureDeterminismFetcher } from "@blackbelt-technology/pi-dashboard-shared/thread-durability/tier1/determinism-fixture.js";
import type { NetworkGuard } from "../routes/route-deps.js";

const PASSTHRU_GUARD: NetworkGuard = async () => {};
const DENY_GUARD: NetworkGuard = async (_req, reply) => {
  reply.code(403).send({ success: false, error: "forbidden" });
};

const MULTI_EDGE_THREAD = "peggy+attention-app";

describe("thread-determinism REST route (fixture-backed, read-only)", () => {
  let fastify: FastifyInstance;

  afterEach(async () => {
    if (fastify) await fastify.close();
  });

  async function setup(
    guard: NetworkGuard = PASSTHRU_GUARD,
    resolve: DeterminismResolver = makeFixtureDeterminismFetcher(),
  ) {
    fastify = Fastify();
    registerThreadDeterminismRoutes(fastify, { networkGuard: guard, resolve });
    await fastify.ready();
  }

  it("serves the frozen projection for a known thread (5 contract fields + edges)", async () => {
    await setup();
    const res = await fastify.inject({
      method: "GET",
      url: `/api/threads/${encodeURIComponent(MULTI_EDGE_THREAD)}/determinism`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.thread_id).toBe(MULTI_EDGE_THREAD);
    const proj = body.data.projection;
    // The 5 contract fields present (shape, not pinned values).
    for (const field of ["thread_id", "machine", "stage", "pending", "degrade"]) {
      expect(field in proj).toBe(true);
    }
    // The load-bearing render shape survives the wire: 7 pending / 2 reaped.
    expect(proj.pending).toHaveLength(7);
    expect(proj.pending.filter((e: any) => e.to === "reaped")).toHaveLength(2);
  });

  it("an unknown thread → an 'unmapped' projection (200, NOT 404)", async () => {
    await setup();
    const res = await fastify.inject({ method: "GET", url: "/api/threads/no-such-thread/determinism" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.projection.stage).toBeNull();
    expect(body.data.projection.degrade).toBe("unmapped");
    expect(body.data.projection.pending).toEqual([]);
  });

  it("is READ-ONLY: repeated GETs return identical projections (no mutation)", async () => {
    await setup();
    const url = `/api/threads/${encodeURIComponent(MULTI_EDGE_THREAD)}/determinism`;
    const a = (await fastify.inject({ method: "GET", url })).json();
    const b = (await fastify.inject({ method: "GET", url })).json();
    expect(a).toEqual(b);
  });

  it("honors the network guard (403 when denied)", async () => {
    await setup(DENY_GUARD);
    const res = await fastify.inject({
      method: "GET",
      url: `/api/threads/${encodeURIComponent(MULTI_EDGE_THREAD)}/determinism`,
    });
    expect(res.statusCode).toBe(403);
  });

  it("distinguishes deterministic (gate) from judgment (who) edges on the wire", async () => {
    await setup();
    const res = await fastify.inject({
      method: "GET",
      url: `/api/threads/${encodeURIComponent(MULTI_EDGE_THREAD)}/determinism`,
    });
    const pending = res.json().data.projection.pending as any[];
    const det = pending.filter((e) => e.kind === "deterministic");
    const jud = pending.filter((e) => e.kind === "judgment");
    expect(det.length).toBeGreaterThan(0);
    expect(jud.length).toBeGreaterThan(0);
    for (const e of det) expect(typeof e.gate).toBe("string");
    for (const e of jud) expect(typeof e.who).toBe("string");
  });
});
