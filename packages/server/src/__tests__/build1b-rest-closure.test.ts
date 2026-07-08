/**
 * Build 1b — C-REST-CLOSURE red-arm suite.
 *
 * Proves the REST session-write seam is closed through the SAME central
 * `authorizeSessionAction` chokepoint the WS seam uses, with operator-only
 * enforcement + a mechanically-total action enumeration. Every case is RED-ARM
 * (see the build report §red-arm): plant the violation → the test FAILS →
 * restore → PASS. The plant instructions are in each block's header comment.
 *
 * Cases (mandate 2 + §7 carries):
 *   (a) F4-closed        — multi-op ON, anonymous POST /prompt → 401, never
 *                          reaches piGateway (bridge inbox empty).
 *   (b) REST principal   — valid cookie → gate observes the EXACT decoded sub.
 *   (c) operator-only    — op-2 shutdown REFUSED (403); op-1 shutdown allowed;
 *                          op-2 send_prompt (co-drive) allowed.
 *   (d) enumeration       — every gated route maps to a known class; the gate
 *                          fail-CLOSED refuses an unclassified action.
 *   (e) anti-spoof (REST) — a body-supplied author/principal never becomes the
 *                          actor; the actor derives ONLY from the cookie.
 *   (H-NIT2) handler-arm  — (null-principal, flag-ON) through handleSendPrompt
 *                          suppresses the forward + emits send_prompt_failed.
 *
 * HOME is set per-test to a fresh tmp dir so loadConfig() reads a controlled
 * config.json.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { WebSocket } from "ws";
import { loadConfig } from "@blackbelt-technology/pi-dashboard-shared/config.js";
import { signToken, COOKIE_NAME, type TokenPayload } from "../auth.js";
import { createTestServer, type TestServerHandle } from "../test-support/test-server.js";
import {
  authorizeSessionAction,
  actionClass,
  SESSION_WRITE_ACTIONS,
  SESSION_WRITE_ACTION_CLASS,
} from "../session-authz.js";
import { handleSendPrompt } from "../browser-handlers/session-action-handler.js";
import type { BrowserHandlerContext } from "../browser-handlers/handler-context.js";

// Record every actor the gate is asked to authorize, delegating to the REAL
// implementation (no behavior change) — the observation seam for (b) + (e).
const observedActors: Array<{ kind: string; sub?: string | null; action: string }> = [];
vi.mock("../session-authz.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session-authz.js")>();
  return {
    ...actual,
    authorizeSessionAction: (input: Parameters<typeof actual.authorizeSessionAction>[0]) => {
      const actor = input.actor;
      observedActors.push({
        kind: actor.kind,
        sub: actor.kind === "human" ? actor.principal?.sub ?? null : undefined,
        action: input.action,
      });
      return actual.authorizeSessionAction(input);
    },
  };
});

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function tryOpen(ws: WebSocket, ms = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: boolean) => { if (!settled) { settled = true; resolve(v); } };
    if (ws.readyState === WebSocket.OPEN) return done(true);
    ws.on("open", () => done(true));
    ws.on("error", () => done(false));
    ws.on("unexpected-response", () => done(false));
    setTimeout(() => done(ws.readyState === WebSocket.OPEN), ms);
  });
}

// ───────────────────────────────────────────────────────────────────────────
// (d) enumeration completeness — pure unit assertions (no server needed)
// ───────────────────────────────────────────────────────────────────────────
describe("Build 1b (d) — session-write action enumeration is mechanically total", () => {
  // The gated session-write actions: the 14 session-api routes + retire +
  // the 2 WS-only process-control actions (kill_process/force_kill) + the 6
  // PUSHBACK-1 found-missed WS-only handlers (role_set/flow_management/
  // role_preset_save/delete/load = operator-only; request_roles = co-drive) +
  // the 2 PUSHBACK-2 WS-only action tokens (reload = /reload kill+respawn,
  // ui_management = the mutating action-gated ui_management; both operator-only) +
  // the PUSHBACK-3 prompt-command (a command-form send_prompt text = operator-only,
  // BOTH seams, no distinct message-type — classified from the text)
  // so completeness stays total across BOTH seams.
  const EXPECTED_ACTIONS = [
    "send_prompt", "abort", "shutdown", "rename", "resurrect", "hide", "unhide",
    "spawn", "resume", "flow-control", "model", "thinking-level",
    "attach-proposal", "detach-proposal", "retire",
    "kill_process", "force_kill",
    "role_set", "flow_management", "role_preset_save", "role_preset_delete",
    "role_preset_load", "request_roles",
    "reload", "ui_management",
    "prompt-command",
  ].sort();
  // co-drive actions (both op-1 and op-2 may perform): send_prompt + abort (the
  // safety emergency-stop) + request_roles (a READ — lists roles, no mutation,
  // PUSHBACK-1 Fix 1a). Everything else is operator-only.
  const CO_DRIVE_ACTIONS = ["send_prompt", "abort", "request_roles"];

  it("every expected session-write action is enumerated with exactly one class", () => {
    expect([...SESSION_WRITE_ACTIONS].sort()).toEqual(EXPECTED_ACTIONS);
    for (const a of SESSION_WRITE_ACTIONS) {
      const cls = actionClass(a);
      expect(cls, `action ${a} must be classified`).toBeDefined();
      expect(["co-drive", "operator-only", "service-allowed"]).toContain(cls);
    }
  });

  it("send_prompt + abort + request_roles are co-drive; every lifecycle/mutation action is operator-only", () => {
    expect(actionClass("send_prompt")).toBe("co-drive");
    expect(actionClass("abort")).toBe("co-drive"); // safety emergency-stop
    expect(actionClass("request_roles")).toBe("co-drive"); // read — lists roles
    for (const a of SESSION_WRITE_ACTIONS) {
      if (CO_DRIVE_ACTIONS.includes(a)) continue;
      expect(actionClass(a), `${a} should be operator-only`).toBe("operator-only");
    }
  });

  it("the gate FAIL-CLOSES on an unclassified action when the flag is ON", () => {
    // Red-arm: add an unclassified action token here / omit a route from the
    // enumeration → this refusal flips to allowed and the test fails.
    const principal = { sub: "op1@example.com", name: "Op", username: "op1", provider: "github", exp: 0 } as TokenPayload;
    const decision = authorizeSessionAction({
      actor: { kind: "human", principal },
      action: "totally-unknown-action",
      requireBrowserAuth: true,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("unclassified-action");
    // …and a KNOWN co-drive action for the same actor is allowed (control).
    expect(
      authorizeSessionAction({ actor: { kind: "human", principal }, action: "send_prompt", requireBrowserAuth: true }).allowed,
    ).toBe(true);
  });

  it("class map has no stray keys beyond the expected set", () => {
    expect(Object.keys(SESSION_WRITE_ACTION_CLASS).sort()).toEqual(EXPECTED_ACTIONS);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (c-unit) operator-only enforcement — pure gate assertions
// ───────────────────────────────────────────────────────────────────────────
describe("Build 1b (c-unit) — operator-only enforcement at the gate", () => {
  const OP1 = { sub: "op1@example.com", name: "Op One", username: "op1", provider: "github", exp: 0 } as TokenPayload;
  const OP2 = { sub: "op2@example.com", name: "Op Two", username: "op2", provider: "github", exp: 0 } as TokenPayload;
  const operatorUsers = ["op1@example.com"];

  it("op-2 (non-operator human) is REFUSED an operator-only action", () => {
    // Red-arm: misclassify shutdown as co-drive → op-2 passes → this fails.
    const d = authorizeSessionAction({ actor: { kind: "human", principal: OP2 }, action: "shutdown", requireBrowserAuth: true, operatorUsers });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("operator-only");
  });

  it("op-1 (operator) is ALLOWED an operator-only action", () => {
    expect(authorizeSessionAction({ actor: { kind: "human", principal: OP1 }, action: "shutdown", requireBrowserAuth: true, operatorUsers }).allowed).toBe(true);
  });

  it("op-2 IS allowed the co-drive action (send_prompt) — a bounded co-driver still drives", () => {
    expect(authorizeSessionAction({ actor: { kind: "human", principal: OP2 }, action: "send_prompt", requireBrowserAuth: true, operatorUsers }).allowed).toBe(true);
  });

  it("a service actor CANNOT satisfy operator-only, but CAN co-drive (mandate 4d)", () => {
    const svc = { kind: "service", id: "rest-shared-secret" } as const;
    expect(authorizeSessionAction({ actor: svc, action: "shutdown", requireBrowserAuth: true, operatorUsers }).allowed).toBe(false);
    expect(authorizeSessionAction({ actor: svc, action: "shutdown", requireBrowserAuth: true, operatorUsers }).reason).toBe("operator-only");
    expect(authorizeSessionAction({ actor: svc, action: "send_prompt", requireBrowserAuth: true, operatorUsers }).allowed).toBe(true);
  });

  it("INERT when operatorUsers unset: op-2 may do an operator-only action (flag-ON-without-operator = op-1-only-with-cookie posture)", () => {
    expect(authorizeSessionAction({ actor: { kind: "human", principal: OP2 }, action: "shutdown", requireBrowserAuth: true }).allowed).toBe(true);
  });

  it("username match works (operatorUsers by username, not just email)", () => {
    expect(authorizeSessionAction({ actor: { kind: "human", principal: OP1 }, action: "shutdown", requireBrowserAuth: true, operatorUsers: ["op1"] }).allowed).toBe(true);
    expect(authorizeSessionAction({ actor: { kind: "human", principal: OP2 }, action: "shutdown", requireBrowserAuth: true, operatorUsers: ["op1"] }).allowed).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (H-M2) sub-validation — a human with a sub-less principal is refused
// ───────────────────────────────────────────────────────────────────────────
describe("Build 1b (H-M2) — a human actor must carry a usable sub", () => {
  it("refuses a non-null principal with an empty/missing sub (flag ON)", () => {
    // Red-arm: drop the hasUsableSub check in authorizeSessionAction → these
    // pass as allowed → this fails.
    const subless = { name: "No Sub", username: "x", provider: "github", exp: 0 } as unknown as TokenPayload;
    const empty = { sub: "   ", name: "Empty", username: "x", provider: "github", exp: 0 } as TokenPayload;
    expect(authorizeSessionAction({ actor: { kind: "human", principal: subless }, action: "send_prompt", requireBrowserAuth: true }).reason).toBe("invalid-principal");
    expect(authorizeSessionAction({ actor: { kind: "human", principal: empty }, action: "send_prompt", requireBrowserAuth: true }).reason).toBe("invalid-principal");
  });

  it("a sub-less principal is NOT an operator even if listed (nothing to match)", () => {
    const subless = { name: "No Sub", username: "", provider: "github", exp: 0 } as unknown as TokenPayload;
    const d = authorizeSessionAction({ actor: { kind: "human", principal: subless }, action: "shutdown", requireBrowserAuth: true, operatorUsers: ["op1@example.com"] });
    expect(d.allowed).toBe(false);
    // Refused at the sub-check first (invalid-principal), before operator-only.
    expect(d.reason).toBe("invalid-principal");
  });

  it("flag OFF: a sub-less principal is allowed (byte-unchanged, nothing reads it)", () => {
    const subless = { name: "No Sub", username: "x", provider: "github", exp: 0 } as unknown as TokenPayload;
    expect(authorizeSessionAction({ actor: { kind: "human", principal: subless }, action: "shutdown", requireBrowserAuth: false }).allowed).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (H-NIT2) null-principal handler-arm through handleSendPrompt (flag ON)
// ───────────────────────────────────────────────────────────────────────────
describe("Build 1b (H-NIT2) — handleSendPrompt fail-closed forward-suppression", () => {
  it("(null principal, flag ON): no forward + send_prompt_failed{unauthorized}", async () => {
    // Red-arm: remove the `if (!decision.allowed)` return in handleSendPrompt →
    // the forward happens → forwarded.length===1 → this fails.
    const forwarded: any[] = [];
    const sent: any[] = [];
    const ctx = {
      ws: { readyState: 1, OPEN: 1, bufferedAmount: 0 } as any,
      sessionManager: { get: vi.fn(() => ({ sessionId: "s1", status: "streaming", cwd: "/tmp", sessionFile: "/tmp/s1.jsonl" })), update: vi.fn() } as any,
      eventStore: {} as any,
      piGateway: { sendToSession: vi.fn((_s: string, o: any) => { forwarded.push(o); return true; }) } as any,
      headlessPidRegistry: { getPid: vi.fn(() => undefined) } as any,
      pendingResumeRegistry: { record: vi.fn(), consume: vi.fn() } as any,
      principal: null,
      requireBrowserAuth: true,
      sendTo: vi.fn((_ws: any, m: any) => { sent.push(m); }),
      broadcast: vi.fn(),
      getSubscribers: () => [],
      trackUiRequest: vi.fn(),
      replayPendingUiRequests: vi.fn(),
      markReplaying: vi.fn(),
      clearReplaying: vi.fn(),
    } as unknown as BrowserHandlerContext;

    await handleSendPrompt({ type: "send_prompt", sessionId: "s1", text: "hi", queueNonce: "n1" } as any, ctx);

    expect(forwarded).toHaveLength(0);
    const failure = sent.find((m) => m.type === "send_prompt_failed");
    expect(failure).toBeDefined();
    expect(failure.reason).toBe("unauthorized");
    expect(failure.queueNonce).toBe("n1");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (a,b,c,e) REAL-server REST integration
// ───────────────────────────────────────────────────────────────────────────
describe("Build 1b — REST session-write closure (real server)", () => {
  let testDir: string;
  let configFile: string;
  let origHome: string;
  let handle: TestServerHandle | undefined;
  const SECRET = "build1b-rest-closure-secret";

  beforeEach(() => {
    observedActors.length = 0;
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "b1b-rest-"));
    fs.mkdirSync(path.join(testDir, ".pi", "dashboard"), { recursive: true });
    configFile = path.join(testDir, ".pi", "dashboard", "config.json");
    origHome = process.env.HOME!;
    process.env.HOME = testDir;
  });

  afterEach(async () => {
    if (handle) { await handle.stop(); handle = undefined; }
    process.env.HOME = origHome;
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  async function bootMultiOp(operatorUsers?: string[]) {
    fs.writeFileSync(configFile, JSON.stringify({
      auth: { secret: SECRET, requireBrowserAuth: true, ...(operatorUsers ? { operatorUsers } : {}) },
    }));
    const loaded = loadConfig();
    expect(loaded.auth?.requireBrowserAuth).toBe(true);
    handle = await createTestServer({
      authConfig: loaded.auth,
      resolvedTrustedNetworks: loaded.resolvedTrustedNetworks,
    });
    return handle;
  }

  function cookie(sub: string) {
    const token = signToken({ sub, name: "N", username: sub.split("@")[0], provider: "github" }, SECRET);
    return `${COOKIE_NAME}=${token}`;
  }

  // ── (a) F4-closed ───────────────────────────────────────────────────────
  it("(a) F4-closed: multi-op ON, anonymous POST /prompt → 401 and never reaches piGateway", async () => {
    // Red-arm: drop `{ preHandler: gate("send_prompt") }` on the /prompt route
    // (or make the gate return allowed:true) → the anonymous prompt gets a 502
    // (reaches piGateway, no bridge) instead of 401, and the bridge inbox would
    // see the send if a bridge were attached → this fails.
    const h = await bootMultiOp();
    h.server.sessionManager.register({ id: "sF4", cwd: "/tmp", source: "tui" as const, startedAt: Date.now() });

    // Attach a real bridge that records inbound sends.
    const bridge = new WebSocket(`ws://localhost:${h.piPort}`);
    await tryOpen(bridge);
    bridge.send(JSON.stringify({ type: "session_register", sessionId: "sF4", cwd: "/tmp", source: "tui", name: "F4" }));
    bridge.send(JSON.stringify({ type: "replay_complete", sessionId: "sF4" }));
    const bridgeInbox: any[] = [];
    bridge.on("message", (raw) => { try { bridgeInbox.push(JSON.parse(raw.toString())); } catch { /* noop */ } });
    await delay(150);

    // Anonymous (no cookie) prompt → refused at the gate.
    const res = await fetch(`http://localhost:${h.httpPort}/api/session/sF4/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "anon attack" }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.reason).toBe("no-principal");

    await delay(150);
    // The prompt NEVER reached the bridge.
    expect(bridgeInbox.find((m) => m.type === "send_prompt")).toBeUndefined();
    bridge.close();
    await delay(50);
  }, 20000);

  // ── (b) REST principal-capture (exact sub) ────────────────────────────────
  it("(b) valid cookie → the gate observes the EXACT decoded sub from the cookie", async () => {
    // Red-arm: discard/hardcode the principal in the auth-plugin onRequest hook
    // (e.g. always stash a fixed sub) → the observed sub ≠ the cookie sub → this
    // fails. Per-test unique nonce sub so a hardcode cannot coincidentally match.
    const uniqueSub = `op-${Date.now()}-${Math.floor(process.hrtime()[1] % 100000)}@example.com`;
    const h = await bootMultiOp();
    h.server.sessionManager.register({ id: "sB", cwd: "/tmp", source: "tui" as const, startedAt: Date.now() });

    const res = await fetch(`http://localhost:${h.httpPort}/api/session/sB/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie(uniqueSub) },
      body: JSON.stringify({ text: "hi" }),
    });
    // No bridge → 502 (passed the gate; the point is the gate SAW the exact sub).
    expect(res.status).toBe(502);
    const promptObs = observedActors.filter((a) => a.action === "send_prompt");
    expect(promptObs.length).toBeGreaterThanOrEqual(1);
    // EXACT: every send_prompt the gate saw carried the cookie's sub, never null
    // or a different sub.
    expect(promptObs.every((a) => a.kind === "human" && a.sub === uniqueSub)).toBe(true);
  }, 20000);

  // ── (c) operator-only enforcement over REAL REST ─────────────────────────
  it("(c) op-2 shutdown REFUSED (403); op-1 shutdown allowed; op-2 send_prompt allowed", async () => {
    // Red-arm: misclassify shutdown as co-drive in SESSION_WRITE_ACTION_CLASS →
    // op-2's shutdown returns 200 → this fails.
    const h = await bootMultiOp(["op1@example.com"]);
    h.server.sessionManager.register({ id: "sShut2", cwd: "/tmp", source: "tui" as const, startedAt: Date.now() });
    h.server.sessionManager.register({ id: "sShut1", cwd: "/tmp", source: "tui" as const, startedAt: Date.now() });
    h.server.sessionManager.register({ id: "sDrive2", cwd: "/tmp", source: "tui" as const, startedAt: Date.now() });

    // op-2 shutdown → 403 operator-only.
    const shut2 = await fetch(`http://localhost:${h.httpPort}/api/session/sShut2/shutdown`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie("op2@example.com") }, body: "{}",
    });
    expect(shut2.status).toBe(403);
    expect((await shut2.json()).reason).toBe("operator-only");
    // Session still present (shutdown handler never ran).
    expect(h.server.sessionManager.get("sShut2")).toBeDefined();

    // op-1 shutdown → allowed (200).
    const shut1 = await fetch(`http://localhost:${h.httpPort}/api/session/sShut1/shutdown`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie("op1@example.com") }, body: "{}",
    });
    expect(shut1.status).toBe(200);

    // op-2 send_prompt (co-drive) → passes the gate (502, no bridge — NOT 403).
    const drive2 = await fetch(`http://localhost:${h.httpPort}/api/session/sDrive2/prompt`, {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie("op2@example.com") }, body: JSON.stringify({ text: "co-drive" }),
    });
    expect(drive2.status).toBe(502);
  }, 20000);

  // ── (e) anti-spoof (REST) ────────────────────────────────────────────────
  it("(e) a body-supplied author/principal never becomes the actor — actor derives ONLY from the cookie", async () => {
    // Red-arm: source the actor from the request body (e.g. read
    // request.body.principal) in buildActorFromRequest → the spoofed operator
    // sub is observed and the operator-only action would pass → this fails.
    const h = await bootMultiOp(["op1@example.com"]);
    h.server.sessionManager.register({ id: "sSpoof", cwd: "/tmp", source: "tui" as const, startedAt: Date.now() });

    // op-2's cookie, but the BODY claims to be op-1 (+ a forged author). The
    // gate must judge by the cookie (op-2) → operator-only REFUSED.
    const res = await fetch(`http://localhost:${h.httpPort}/api/session/sSpoof/shutdown`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie("op2@example.com") },
      body: JSON.stringify({ author: "op1@example.com", principal: { sub: "op1@example.com", username: "op1" }, operatorUsers: ["op2@example.com"] }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).reason).toBe("operator-only");
    // The gate observed op-2 (the cookie), NEVER op-1 (the body claim).
    const shutObs = observedActors.filter((a) => a.action === "shutdown");
    expect(shutObs.length).toBeGreaterThanOrEqual(1);
    expect(shutObs.every((a) => a.sub === "op2@example.com")).toBe(true);
    expect(shutObs.some((a) => a.sub === "op1@example.com")).toBe(false);
  }, 20000);

  // ── flag-OFF byte-unchanged over REST ────────────────────────────────────
  it("flag OFF: anonymous loopback POST /prompt behaves exactly as today (no 401 from the gate)", async () => {
    // No auth block at all → single-op. The gate no-ops; the prompt reaches the
    // handler and returns 502 (no bridge), NOT 401. Byte-unchanged.
    fs.writeFileSync(configFile, JSON.stringify({ port: 8000 }));
    const loaded = loadConfig();
    expect(loaded.auth).toBeUndefined();
    handle = await createTestServer({ authConfig: loaded.auth, resolvedTrustedNetworks: loaded.resolvedTrustedNetworks });
    handle.server.sessionManager.register({ id: "sOff", cwd: "/tmp", source: "tui" as const, startedAt: Date.now() });
    const res = await fetch(`http://localhost:${handle.httpPort}/api/session/sOff/prompt`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "hi" }),
    });
    expect(res.status).toBe(502);
  }, 20000);
});
