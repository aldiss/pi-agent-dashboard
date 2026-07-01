/**
 * Tests for session control REST API endpoints (session-api.ts).
 */
import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
import { createServer, type DashboardServer } from "../server.js";
import { spawnPiSession } from "../process-manager.js";

const mockSpawnPiSession = vi.mocked(spawnPiSession);

const httpPort = 19200;
const piPort = 19201;
let server: DashboardServer;

// Injectable post-respawn VERIFY-gate seam (build-gate item 2). Default passes;
// individual tests override `verifyImpl` to exercise the gate-rejection path.
// The real-oracle gate + 5-variant RED-arm live in resurrection-verify.test.ts.
let verifyImpl: (sessionId: string) => Promise<import("../resurrection-verify.js").VerifyResult> = async () => ({
  ok: true,
  retried: false,
  attempts: 1,
});
const verifyCalls: string[] = [];

// Mock spawnPiSession to avoid actually spawning processes
vi.mock("../process-manager.js", async (importOriginal) => {
  const orig: any = await importOriginal();
  return {
    ...orig,
    spawnPiSession: vi.fn().mockResolvedValue({ success: true, message: "spawned" }),
  };
});

function url(path: string) {
  return `http://localhost:${httpPort}${path}`;
}

async function postJson(path: string, body?: Record<string, unknown>) {
  return fetch(url(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

/** Register a fresh session, returning its id */
function registerSession(id: string, overrides?: Record<string, unknown>) {
  server.sessionManager.register({
    id,
    cwd: "/tmp/test",
    source: "tui" as const,
    startedAt: Date.now(),
    ...overrides,
  });
  return id;
}

describe("Session Control REST API", () => {
  beforeAll(async () => {
    server = await createServer({
      port: httpPort,
      piPort,
      dev: true,
      autoShutdown: false,
      shutdownIdleSeconds: 999,
      tunnel: false,
    editor: { idleTimeoutMinutes: 10, maxInstances: 3 },
      resurrectVerify: (sessionId: string) => {
        verifyCalls.push(sessionId);
        return verifyImpl(sessionId);
      },
    });
    await server.start();
  });

  afterAll(async () => {
    if (server) {
      try { await server.stop(); } catch { /* */ }
    }
  });

  // ── prompt ──────────────────────────────────────────────────────

  it("POST /api/session/:id/prompt — 404 for unknown session", async () => {
    const res = await postJson("/api/session/unknown-id/prompt", { text: "hello" });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe("session not found");
  });

  it("POST /api/session/:id/prompt — 400 when text missing", async () => {
    const res = await postJson("/api/session/any-id/prompt", {});
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("text is required");
  });

  it("POST /api/session/:id/prompt — 502 when no bridge connection", async () => {
    registerSession("prompt-no-bridge");
    const res = await postJson("/api/session/prompt-no-bridge/prompt", { text: "hello" });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("no bridge connection for session");
  });

  // ── abort ───────────────────────────────────────────────────────

  it("POST /api/session/:id/abort — 404 for unknown", async () => {
    const res = await postJson("/api/session/unknown/abort");
    expect(res.status).toBe(404);
  });

  it("POST /api/session/:id/abort — success for known session", async () => {
    registerSession("abort-ok");
    const res = await postJson("/api/session/abort-ok/abort");
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
  });

  // ── shutdown ────────────────────────────────────────────────────

  it("POST /api/session/:id/shutdown — 404 for unknown", async () => {
    const res = await postJson("/api/session/unknown/shutdown");
    expect(res.status).toBe(404);
  });

  it("POST /api/session/:id/shutdown — unregisters session", async () => {
    registerSession("shutdown-me");
    const res = await postJson("/api/session/shutdown-me/shutdown");
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    expect(server.sessionManager.get("shutdown-me")?.status).toBe("ended");
  });

  // ── rename ──────────────────────────────────────────────────────

  it("POST /api/session/:id/rename — 400 when name missing", async () => {
    const res = await postJson("/api/session/any/rename", {});
    expect(res.status).toBe(400);
  });

  it("POST /api/session/:id/rename — renames session", async () => {
    registerSession("rename-me");
    const res = await postJson("/api/session/rename-me/rename", { name: "new-name" });
    expect(res.status).toBe(200);
    expect(server.sessionManager.get("rename-me")?.name).toBe("new-name");
  });

  // ── W4: rename write-pin (name-sync-write-pin) ──────────────────
  // The real route must ALSO write `operatorPinnedName` into the messenger
  // registry so the rename survives a name-sync tick. Faithful route proof via
  // a tmp registry pointed at by PI_MESSENGER_REGISTRY_DIR.
  it("POST /api/session/:id/rename — writes operatorPinnedName to the registry (survives name-sync)", async () => {
    const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const regDir = mkdtempSync(join(tmpdir(), "w4-route-registry-"));
    const sid = "w4-pin-session";
    writeFileSync(
      join(regDir, "Pete.json"),
      JSON.stringify({ name: "Pete", pid: 999999, sessionId: sid, statusMessage: "busy" }, null, 2),
    );
    const prev = process.env.PI_MESSENGER_REGISTRY_DIR;
    process.env.PI_MESSENGER_REGISTRY_DIR = regDir;
    try {
      registerSession(sid, { name: "Pete" });
      const res = await postJson(`/api/session/${sid}/rename`, { name: "Pete tenure-9 — IronForge" });
      expect(res.status).toBe(200);
      const written = JSON.parse(readFileSync(join(regDir, "Pete.json"), "utf8"));
      // The pin is set (F5-write) and the auto-derived `name` is preserved so
      // name-sync honors the pin over "Pete — busy".
      expect(written.operatorPinnedName).toBe("Pete tenure-9 — IronForge");
      expect(written.name).toBe("Pete");
    } finally {
      if (prev === undefined) delete process.env.PI_MESSENGER_REGISTRY_DIR;
      else process.env.PI_MESSENGER_REGISTRY_DIR = prev;
    }
  });

  it("POST /api/session/:id/rename — pin write is best-effort (no registry entry → still 200)", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const emptyReg = mkdtempSync(join(tmpdir(), "w4-empty-registry-"));
    const prev = process.env.PI_MESSENGER_REGISTRY_DIR;
    process.env.PI_MESSENGER_REGISTRY_DIR = emptyReg;
    try {
      registerSession("w4-no-entry");
      const res = await postJson("/api/session/w4-no-entry/rename", { name: "Dashboard Only" });
      // No mesh registry entry for this session → pin write is a benign miss;
      // the rename itself still succeeds.
      expect(res.status).toBe(200);
      expect(server.sessionManager.get("w4-no-entry")?.name).toBe("Dashboard Only");
    } finally {
      if (prev === undefined) delete process.env.PI_MESSENGER_REGISTRY_DIR;
      else process.env.PI_MESSENGER_REGISTRY_DIR = prev;
    }
  });

  // ── resurrect (Component B) ─────────────────────────────────────

  it("POST /api/session/:id/resurrect — 404 for unknown session", async () => {
    const res = await postJson("/api/session/unknown-id/resurrect");
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("session not found");
  });

  it("POST /api/session/:id/resurrect — 400 for claude-code session (read-only)", async () => {
    registerSession("cc-resurrect", { source: "claude-code", sessionFile: "/path/cc.jsonl" });
    const res = await postJson("/api/session/cc-resurrect/resurrect");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/read-only/);
  });

  it("POST /api/session/:id/resurrect — truly-ended (no bridge, dead driver) → respawn + verify", async () => {
    // No :9999 bridge in this test server + fresh HOME means resolveDriverLiveness
    // returns {alive:false} → case 3 (clean continue respawn). spawnPiSession is
    // mocked; the post-respawn verify gate is injected (passes) so the endpoint
    // returns success only after the gate runs. See change: unend-mechanism-v2.
    verifyImpl = async () => ({ ok: true, retried: false, attempts: 1 });
    verifyCalls.length = 0;
    registerSession("ended-resurrect", { sessionFile: "/path/ended.jsonl" });
    server.sessionManager.update("ended-resurrect", { status: "ended", endedAt: Date.now() });
    const res = await postJson("/api/session/ended-resurrect/resurrect");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({ resurrected: true, mode: "respawn", verified: true });
    // The gate MUST have run for this session (no spawn-and-hope).
    expect(verifyCalls).toContain("ended-resurrect");
  });

  it("POST /api/session/:id/resurrect — respawn is PINNED to this server's runtime pi-gateway port", async () => {
    // ENV-INDEPENDENT ANTI-CROSS-WIRE PIN (change: pin-on-resurrect). The
    // resurrect respawn MUST carry pinDashboardUrl = ws://localhost:<runtime
    // piPort> so the spawned bridge captures `pinnedUrl` → ISOLATION GUARD →
    // no mDNS migration to a sibling local dashboard. The port MUST be the
    // RUNTIME gateway port (piGateway.address() === piPort here), not a
    // config-file default.
    verifyImpl = async () => ({ ok: true, retried: false, attempts: 1 });
    mockSpawnPiSession.mockClear();
    registerSession("pinned-resurrect", { sessionFile: "/path/pinned.jsonl" });
    server.sessionManager.update("pinned-resurrect", { status: "ended", endedAt: Date.now() });
    const res = await postJson("/api/session/pinned-resurrect/resurrect");
    expect(res.status).toBe(200);
    expect(mockSpawnPiSession).toHaveBeenCalledTimes(1);
    const [, opts] = mockSpawnPiSession.mock.calls[0]!;
    expect(opts).toMatchObject({
      sessionFile: "/path/pinned.jsonl",
      mode: "continue",
      strategy: "tmux",
      pinDashboardUrl: `ws://localhost:${piPort}`,
    });
  });

  it("POST /api/session/:id/resurrect — verify gate REJECTS a non-interactable respawn → 503", async () => {
    // Respawn 'succeeds' (mocked) but the gate's real oracle finds the session
    // not interactable → the endpoint surfaces a LOUD 503, never a false-green.
    // This is the v1-incident guard: 'started' ≠ 'interactable'.
    verifyImpl = async () => ({
      ok: false,
      failedAssertion: "model-changeable",
      detail: "set_model produced no observed session.model change (model-unreachable)",
      retried: true,
      attempts: 2,
    });
    registerSession("verify-reject", { sessionFile: "/path/reject.jsonl" });
    server.sessionManager.update("verify-reject", { status: "ended", endedAt: Date.now() });
    const res = await postJson("/api/session/verify-reject/resurrect");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/verify gate REJECTED/);
    expect(body.error).toMatch(/model-changeable/);
    // Restore the default passing gate for any later tests.
    verifyImpl = async () => ({ ok: true, retried: false, attempts: 1 });
  });

  it("POST /api/session/:id/resurrect — 400 when session file is unknown (truly-ended path)", async () => {
    registerSession("no-file-resurrect");
    server.sessionManager.update("no-file-resurrect", { status: "ended", endedAt: Date.now(), sessionFile: undefined });
    const res = await postJson("/api/session/no-file-resurrect/resurrect");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/session file is unknown/);
  });

  // ── hide/unhide ─────────────────────────────────────────────────

  it("POST /api/session/:id/hide — hides session", async () => {
    registerSession("hide-me");
    const res = await postJson("/api/session/hide-me/hide");
    expect(res.status).toBe(200);
    expect(server.sessionManager.get("hide-me")?.hidden).toBe(true);
  });

  it("POST /api/session/:id/unhide — unhides session", async () => {
    registerSession("unhide-me");
    server.sessionManager.update("unhide-me", { hidden: true });
    const res = await postJson("/api/session/unhide-me/unhide");
    expect(res.status).toBe(200);
    expect(server.sessionManager.get("unhide-me")?.hidden).toBe(false);
  });

  // ── spawn ───────────────────────────────────────────────────────

  it("POST /api/session/spawn — 400 when cwd missing", async () => {
    const res = await postJson("/api/session/spawn", {});
    expect(res.status).toBe(400);
  });

  it("POST /api/session/spawn — success with valid cwd", async () => {
    const res = await postJson("/api/session/spawn", { cwd: "/tmp/project" });
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
  });

  // ── resume ──────────────────────────────────────────────────────

  it("POST /api/session/:id/resume — 400 for invalid mode", async () => {
    const res = await postJson("/api/session/any/resume", { mode: "invalid" });
    expect(res.status).toBe(400);
  });

  it("POST /api/session/:id/resume — 404 for unknown session", async () => {
    const res = await postJson("/api/session/unknown/resume", { mode: "continue" });
    expect(res.status).toBe(404);
  });

  it("POST /api/session/:id/resume — 409 if session still active", async () => {
    registerSession("resume-active", { sessionFile: "/path/session.jsonl" });
    const res = await postJson("/api/session/resume-active/resume", { mode: "continue" });
    expect(res.status).toBe(409);
  });

  // ── flow-control ────────────────────────────────────────────────

  it("POST /api/session/:id/flow-control — 400 for invalid action", async () => {
    const res = await postJson("/api/session/any/flow-control", { action: "invalid" });
    expect(res.status).toBe(400);
  });

  it("POST /api/session/:id/flow-control — success", async () => {
    registerSession("flow-ctrl");
    const res = await postJson("/api/session/flow-ctrl/flow-control", { action: "abort" });
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
  });

  // ── model ───────────────────────────────────────────────────────

  it("POST /api/session/:id/model — 400 when missing fields", async () => {
    const res = await postJson("/api/session/any/model", { provider: "anthropic" });
    expect(res.status).toBe(400);
  });

  it("POST /api/session/:id/model — success", async () => {
    registerSession("model-set");
    const res = await postJson("/api/session/model-set/model", {
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
    });
    expect(res.status).toBe(200);
  });

  // ── thinking-level ──────────────────────────────────────────────

  it("POST /api/session/:id/thinking-level — 400 when missing", async () => {
    const res = await postJson("/api/session/any/thinking-level", {});
    expect(res.status).toBe(400);
  });

  it("POST /api/session/:id/thinking-level — success", async () => {
    registerSession("think-set");
    const res = await postJson("/api/session/think-set/thinking-level", { level: "high" });
    expect(res.status).toBe(200);
  });

  // ── attach/detach proposal ──────────────────────────────────────

  it("POST /api/session/:id/attach-proposal — 400 when changeName missing", async () => {
    const res = await postJson("/api/session/any/attach-proposal", {});
    expect(res.status).toBe(400);
  });

  it("POST /api/session/:id/attach-proposal — attaches and auto-names", async () => {
    registerSession("attach-me");
    const res = await postJson("/api/session/attach-me/attach-proposal", { changeName: "add-feature" });
    expect(res.status).toBe(200);
    const session = server.sessionManager.get("attach-me");
    expect(session?.attachedProposal).toBe("add-feature");
    expect(session?.name).toBe("add-feature"); // auto-named
  });

  it("POST /api/session/:id/detach-proposal — detaches", async () => {
    registerSession("detach-me");
    server.sessionManager.update("detach-me", { attachedProposal: "some-change" });
    const res = await postJson("/api/session/detach-me/detach-proposal");
    expect(res.status).toBe(200);
    expect(server.sessionManager.get("detach-me")?.attachedProposal).toBeNull();
  });
});
