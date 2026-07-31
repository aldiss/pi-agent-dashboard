// @vitest-environment node
/**
 * DAWN SPOOL AUTHORIZATION — trusted server-side gate on /api/plugins/voice-input/spool.
 *
 * The contract under test (Lane, G3 Dawn transaction):
 *   - Note production is DAWN-ADDRESSED. A non-Dawn pane must produce ZERO spool.
 *   - Authorization MUST NOT rest on a client boolean/header. The only thing the
 *     client supplies is a session ID; the SERVER resolves that id to a name
 *     through the dashboard's own session model and compares it to "Dawn".
 *   - The response is PATH-ONLY: it never echoes transcript bytes back.
 *
 * Layer: a REAL Fastify instance with the REAL register() wiring, driven via
 * fastify.inject(). The only injected seam is `resolveSessionName`, which stands in
 * for the dashboard's PluginSessionManager.getSession(id).name — the same seam the
 * plugin runtime supplies in production.
 *
 * ZERO-SPOOL is asserted on the FILESYSTEM, not on the status code alone: a 403 that
 * still wrote a file would pass a status-only assertion and leak the operator's bytes.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "../server/index.js";

const SPOOL_ROUTE = "/api/plugins/voice-input/spool";
// A tiny non-empty audio payload: emitSpoolEntry refuses to write when audio is empty.
const AUDIO_B64 = Buffer.from("fake-webm-audio-bytes").toString("base64");

let spoolDir: string;
let app: FastifyInstance | null = null;

function spoolFiles(): string[] {
  try {
    return readdirSync(spoolDir);
  } catch {
    return [];
  }
}

async function makeApp(
  resolveSessionName?: (id: string) => string | undefined,
): Promise<FastifyInstance> {
  const fastify = Fastify();
  await register(fastify, { resolveSessionName });
  await fastify.ready();
  app = fastify;
  return fastify;
}

beforeEach(() => {
  spoolDir = mkdtempSync(join(tmpdir(), "dawn-spool-test-"));
  process.env.OBSIDIAN_VOICE_SPOOL_DIR = spoolDir;
});

afterEach(async () => {
  await app?.close();
  app = null;
  delete process.env.OBSIDIAN_VOICE_SPOOL_DIR;
  rmSync(spoolDir, { recursive: true, force: true });
});

describe("Dawn spool authorization — non-Dawn panes produce ZERO spool", () => {
  it("REJECTS a non-Dawn session and writes nothing to the spool", async () => {
    const fastify = await makeApp((id) => (id === "sess-dawn" ? "Dawn" : "Peggy"));

    const res = await fastify.inject({
      method: "POST",
      url: `${SPOOL_ROUTE}?sessionId=sess-peggy`,
      payload: { transcript: "a private dictation", audioBase64: AUDIO_B64 },
    });

    expect(res.statusCode).toBe(403);
    // The filesystem is the real assertion: a rejected call must leave no trace.
    expect(spoolFiles()).toEqual([]);
  });

  it("REJECTS when no sessionId is supplied at all", async () => {
    const fastify = await makeApp(() => "Dawn");

    const res = await fastify.inject({
      method: "POST",
      url: SPOOL_ROUTE,
      payload: { transcript: "no session id", audioBase64: AUDIO_B64 },
    });

    expect(res.statusCode).toBe(403);
    expect(spoolFiles()).toEqual([]);
  });

  it("REJECTS an unknown session id (resolver returns undefined)", async () => {
    const fastify = await makeApp(() => undefined);

    const res = await fastify.inject({
      method: "POST",
      url: `${SPOOL_ROUTE}?sessionId=ghost`,
      payload: { transcript: "unknown session", audioBase64: AUDIO_B64 },
    });

    expect(res.statusCode).toBe(403);
    expect(spoolFiles()).toEqual([]);
  });

  it("FAILS CLOSED when no resolver is wired (misconfiguration must not open the route)", async () => {
    const fastify = await makeApp(undefined);

    const res = await fastify.inject({
      method: "POST",
      url: `${SPOOL_ROUTE}?sessionId=sess-dawn`,
      payload: { transcript: "unwired runtime", audioBase64: AUDIO_B64 },
    });

    expect(res.statusCode).toBe(403);
    expect(spoolFiles()).toEqual([]);
  });
});

describe("Dawn spool authorization — a forged CLIENT claim cannot grant access", () => {
  it("IGNORES body/header claims of being Dawn; only the server-resolved name counts", async () => {
    // The resolver is the dashboard's own session model: this id is NOT Dawn.
    const fastify = await makeApp((id) => (id === "sess-dawn" ? "Dawn" : "Bert"));

    const res = await fastify.inject({
      method: "POST",
      url: `${SPOOL_ROUTE}?sessionId=sess-bert`,
      headers: {
        "x-session-name": "Dawn",
        "x-is-dawn": "true",
      },
      payload: {
        transcript: "forged claim",
        audioBase64: AUDIO_B64,
        sessionName: "Dawn",
        isDawn: true,
      },
    });

    expect(res.statusCode).toBe(403);
    expect(spoolFiles()).toEqual([]);
  });

  it("REJECTS a rename that happens between the pre-parse check and emission", async () => {
    // First call (onRequest) sees Dawn; the second (in-handler recheck) sees the
    // renamed session. The recheck is what closes this race.
    let calls = 0;
    const fastify = await makeApp(() => {
      calls += 1;
      return calls === 1 ? "Dawn" : "NotDawn";
    });

    const res = await fastify.inject({
      method: "POST",
      url: `${SPOOL_ROUTE}?sessionId=sess-racy`,
      payload: { transcript: "renamed mid-flight", audioBase64: AUDIO_B64 },
    });

    expect(calls).toBeGreaterThanOrEqual(2);
    expect(res.statusCode).toBe(403);
    expect(spoolFiles()).toEqual([]);
  });
});

describe("Dawn spool authorization — the Dawn pane is admitted, path-only", () => {
  it("ACCEPTS Dawn, writes the spool entry, and returns ONLY a path reference", async () => {
    const transcript = "buy  coffee\tand milk";
    const fastify = await makeApp((id) => (id === "sess-dawn" ? "Dawn" : "Peggy"));

    const res = await fastify.inject({
      method: "POST",
      url: `${SPOOL_ROUTE}?sessionId=sess-dawn`,
      payload: { transcript, audioBase64: AUDIO_B64 },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      ok?: unknown;
      spoolDir?: unknown;
      id?: unknown;
      entryPath?: unknown;
    };
    expect(body.ok).toBe(true);
    expect(typeof body.spoolDir).toBe("string");
    expect(typeof body.id).toBe("string");

    // Dawn's contract is the exact spool ENTRY identity: the `.json` sidecar
    // the engine consumes via --entry. NOT the `.txt` (one field inside the
    // entry) and NOT the directory (which would let the engine sweep siblings
    // she was never told about). Assert it is derived from spoolDir + id, is
    // neither the directory nor the transcript, and actually resolves to the
    // sidecar for THIS dictation — a plausible string pointing at nothing, or
    // at the wrong entry, would pass a shape check.
    expect(typeof body.entryPath).toBe("string");
    const entryPath = body.entryPath as string;
    expect(entryPath).toBe(join(body.spoolDir as string, `${body.id as string}.json`));
    expect(entryPath.endsWith(".json")).toBe(true);
    expect(entryPath).not.toBe(body.spoolDir);
    expect(entryPath).not.toMatch(/\.txt$/);
    expect(existsSync(entryPath)).toBe(true);
    expect(statSync(entryPath).isFile()).toBe(true);

    // The sidecar names THIS dictation, and its transcript field points at the
    // bytes the operator actually spoke — the identity chain end to end.
    const sidecar = JSON.parse(readFileSync(entryPath, "utf8")) as {
      id?: string;
      transcriptPath?: string;
    };
    expect(sidecar.id).toBe(body.id);
    expect(typeof sidecar.transcriptPath).toBe("string");
    expect(
      Buffer.compare(
        readFileSync(sidecar.transcriptPath as string),
        Buffer.from(transcript, "utf8"),
      ),
    ).toBe(0);

    // PATH-ONLY: the operator's transcript must never travel back in the response.
    expect(res.body).not.toContain(transcript);
    expect(res.body).not.toContain("coffee");

    // The spool entry carries the transcript BYTE-EXACT (double space + tab intact).
    const txt = spoolFiles().find((f) => f.endsWith(".txt"));
    expect(txt).toBeDefined();
    const onDisk = readFileSync(join(spoolDir, txt as string));
    expect(Buffer.compare(onDisk, Buffer.from(transcript, "utf8"))).toBe(0);
  });

  it("REJECTS an empty transcript from Dawn without writing a spool entry", async () => {
    const fastify = await makeApp(() => "Dawn");

    const res = await fastify.inject({
      method: "POST",
      url: `${SPOOL_ROUTE}?sessionId=sess-dawn`,
      payload: { transcript: "   ", audioBase64: AUDIO_B64 },
    });

    expect(res.statusCode).toBe(422);
    expect(spoolFiles()).toEqual([]);
  });
});
