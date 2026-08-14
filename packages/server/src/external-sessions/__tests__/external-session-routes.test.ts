import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { registerExternalSessionRoutes } from "../routes/external-session-routes.js";
import {
  createExternalSessionRegistry,
  type ExternalSessionObservation,
} from "../scanner.js";

function observation(output: string): ExternalSessionObservation {
  return {
    runtime: "codex",
    tmuxSession: "cx-gap2",
    runtimePid: 40716,
    cwd: "/private/tmp/gap2-wt",
    model: "gpt-5.6-sol",
    effort: "ultra",
    output,
    lineCount: output.split("\n").length,
  };
}

describe("external-session routes", () => {
  let fastify: FastifyInstance | undefined;

  afterEach(async () => {
    await fastify?.close();
  });

  it("includes durable outputChangedAt in the list payload while keeping the first sample neutral", async () => {
    let t = 1_000;
    let output = "first sample";
    const registry = createExternalSessionRegistry({
      scan: () => [observation(output)],
      isLive: () => true,
      now: () => t,
    });
    registry.refresh();

    fastify = Fastify();
    registerExternalSessionRoutes(fastify, {
      registry,
      networkGuard: async () => {},
    });

    const first = await fastify.inject({ method: "GET", url: "/api/external-sessions" });
    expect(first.statusCode).toBe(200);
    expect(first.json().sessions[0].outputChangedAt).toBeNull();

    t = 2_000;
    output = "different sample";
    registry.refresh();

    const changed = await fastify.inject({ method: "GET", url: "/api/external-sessions" });
    expect(changed.json().sessions[0].outputChangedAt).toBe(2_000);
  });

  it("capture polling protects an expired ended session from pruning", async () => {
    let t = 1_000;
    let observations = [observation("frozen output")];
    let live = true;
    const registry = createExternalSessionRegistry({
      scan: () => observations,
      isLive: () => live,
      now: () => t,
      retentionMs: 1_000,
      viewGraceMs: 500,
    });
    registry.refresh();

    observations = [];
    live = false;
    t = 1_100;
    registry.refresh();

    fastify = Fastify();
    registerExternalSessionRoutes(fastify, {
      registry,
      networkGuard: async () => {},
    });

    t = 2_099;
    const capture = await fastify.inject({
      method: "GET",
      url: "/api/external-sessions/codex%3Acx-gap2/capture",
    });
    expect(capture.statusCode).toBe(200);
    expect(capture.json().output).toBe("frozen output");

    t = 2_101;
    registry.refresh();
    const list = await fastify.inject({ method: "GET", url: "/api/external-sessions" });
    expect(list.json().sessions).toHaveLength(1);
  });
});
