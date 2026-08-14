import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
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

function makeTranscriptReader() {
  return {
    read: vi.fn(async (session: { id: string }) => ({
      id: session.id,
      source: "capture" as const,
      entries: [],
      truncated: false,
    })),
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
      transcriptReader: makeTranscriptReader(),
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
      transcriptReader: makeTranscriptReader(),
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

  it("returns the injected reader's structured transcript for a known session", async () => {
    const registry = createExternalSessionRegistry({
      scan: () => [observation("raw fallback")],
      isLive: () => true,
      now: () => 1_000,
    });
    registry.refresh();
    const networkGuard = vi.fn(async () => {});
    const transcriptReader = {
      read: vi.fn(async (session: { id: string }) => ({
        id: session.id,
        source: "codex" as const,
        entries: [
          {
            id: "entry-1",
            ts: 1_000,
            kind: "assistant" as const,
            text: "Structured answer",
          },
        ],
        truncated: false,
        transcriptPath: "/tmp/codex-home/sessions/rollout.jsonl",
      })),
    };
    fastify = Fastify();
    registerExternalSessionRoutes(fastify, { registry, networkGuard, transcriptReader });

    const response = await fastify.inject({
      method: "GET",
      url: "/api/external-sessions/codex%3Acx-gap2/transcript",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      id: "codex:cx-gap2",
      source: "codex",
      entries: [
        {
          id: "entry-1",
          ts: 1_000,
          kind: "assistant",
          text: "Structured answer",
        },
      ],
      truncated: false,
      transcriptPath: "/tmp/codex-home/sessions/rollout.jsonl",
    });
    expect(networkGuard).toHaveBeenCalledTimes(1);
    expect(transcriptReader.read).toHaveBeenCalledTimes(1);
    expect(transcriptReader.read.mock.calls[0]?.[0]).toMatchObject({
      id: "codex:cx-gap2",
      runtime: "codex",
      runtimePid: 40716,
    });
  });

  it("returns 404 for an unknown transcript id without calling the reader", async () => {
    const registry = createExternalSessionRegistry({ scan: () => [], isLive: () => true });
    const transcriptReader = makeTranscriptReader();
    fastify = Fastify();
    registerExternalSessionRoutes(fastify, {
      registry,
      transcriptReader,
      networkGuard: async () => {},
    });

    const response = await fastify.inject({
      method: "GET",
      url: "/api/external-sessions/codex%3Amissing/transcript",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "unknown external session: codex:missing" });
    expect(transcriptReader.read).not.toHaveBeenCalled();
  });

  it("runs networkGuard before transcript lookup", async () => {
    const registry = createExternalSessionRegistry({
      scan: () => [observation("raw fallback")],
      isLive: () => true,
    });
    registry.refresh();
    const transcriptReader = makeTranscriptReader();
    const networkGuard = vi.fn(async (_request, reply) => {
      reply.code(403).send({ success: false, error: "Access denied" });
    });
    fastify = Fastify();
    registerExternalSessionRoutes(fastify, { registry, transcriptReader, networkGuard });

    const response = await fastify.inject({
      method: "GET",
      url: "/api/external-sessions/codex%3Acx-gap2/transcript",
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ success: false, error: "Access denied" });
    expect(networkGuard).toHaveBeenCalledTimes(1);
    expect(transcriptReader.read).not.toHaveBeenCalled();
  });

  it("includes injected external-session owners and cell drivers in the list response", async () => {
    const registry = createExternalSessionRegistry({ scan: () => [], isLive: () => true });
    const networkGuard = vi.fn(async () => {});
    const ownersReader = {
      getOwners: vi.fn(() => ({
        "cx-gap2": { owner: "Seatwright", cell: "cell-alpha" },
        "claude-review": { owner: "Docket", cell: null },
      })),
    };
    const driverRegistry = {
      getCellDrivers: vi.fn(() => [
        { realName: "Seatwright", tmux: "seatwright-live", cell: "cell-alpha" },
        { realName: "Docket", tmux: null, cell: null },
      ]),
    };
    fastify = Fastify();
    registerExternalSessionRoutes(fastify, {
      registry,
      networkGuard,
      transcriptReader: makeTranscriptReader(),
      ownersReader,
      driverRegistry,
    });

    const response = await fastify.inject({
      method: "GET",
      url: "/api/external-sessions",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      sessions: [],
      owners: {
        "cx-gap2": { owner: "Seatwright", cell: "cell-alpha" },
        "claude-review": { owner: "Docket", cell: null },
      },
      drivers: [
        { realName: "Seatwright", tmux: "seatwright-live", cell: "cell-alpha" },
        { realName: "Docket", tmux: null, cell: null },
      ],
    });
    expect(networkGuard).toHaveBeenCalledTimes(1);
    expect(ownersReader.getOwners).toHaveBeenCalledTimes(1);
    expect(driverRegistry.getCellDrivers).toHaveBeenCalledTimes(1);
  });

  it("runs networkGuard before reading external-session list metadata", async () => {
    const registry = createExternalSessionRegistry({ scan: () => [], isLive: () => true });
    const ownersReader = { getOwners: vi.fn(() => ({})) };
    const driverRegistry = { getCellDrivers: vi.fn(() => []) };
    const networkGuard = vi.fn(async (_request, reply) => {
      reply.code(403).send({ success: false, error: "Access denied" });
    });
    fastify = Fastify();
    registerExternalSessionRoutes(fastify, {
      registry,
      networkGuard,
      transcriptReader: makeTranscriptReader(),
      ownersReader,
      driverRegistry,
    });

    const response = await fastify.inject({
      method: "GET",
      url: "/api/external-sessions",
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ success: false, error: "Access denied" });
    expect(networkGuard).toHaveBeenCalledTimes(1);
    expect(ownersReader.getOwners).not.toHaveBeenCalled();
    expect(driverRegistry.getCellDrivers).not.toHaveBeenCalled();
  });
});
