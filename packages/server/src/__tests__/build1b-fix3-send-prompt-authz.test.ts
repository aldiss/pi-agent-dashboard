/**
 * Build-1b PUSHBACK-3 FIX-P3-1 + FIX-P3-4 red-arm suite — a co-drive
 * `send_prompt` must NOT reach the bridge COMMAND surface (text) NOR the
 * operator-only `resume` effect (ended-session context).
 *
 * FIX-P3-1 (BLOCKER): `send_prompt` is co-drive, but the bridge PARSES the
 * forwarded text into COMMANDS it EXECUTES — `!`/`!!` → host shell, `/quit` →
 * shutdown, `/reload` → kill+respawn, `/new` → spawn, `/model …` → model switch,
 * `/compact`, any `/slash`. So op-2 could reach the operator-only/host command
 * surface via prompt TEXT on BOTH the WS seam (`handleSendPrompt`) and the REST
 * seam (`POST /api/session/:id/prompt`). The fix classifies the text with the
 * SHARED `parseSendPrompt` (the SAME parser the bridge executes — no drift): a
 * command-form → operator-only `prompt-command` (op-2 REFUSED); a raw
 * passthrough prompt → co-drive `send_prompt` (op-2 allowed).
 *
 * FIX-P3-4 (NEW BLOCKER): op-2 `send_prompt` to an ENDED session triggers an
 * auto-resume `spawnPiSession` (byte-identical to `handleResumeSession`) with
 * ZERO operator re-auth after the co-drive gate = the operator-only `resume`
 * effect. The fix re-authorizes `resume` BEFORE the auto-resume spawn.
 *
 * Every case is RED-ARM (plant instructions in each block header).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { WebSocket } from "ws";
import { loadConfig } from "@blackbelt-technology/pi-dashboard-shared/config.js";
import {
  parseSendPrompt,
  isBridgeCommandText,
} from "@blackbelt-technology/pi-dashboard-shared/prompt-command.js";
import { signToken, COOKIE_NAME } from "../auth.js";
import { createTestServer, type TestServerHandle } from "../test-support/test-server.js";
import { classifySendPromptAction } from "../send-prompt-authz.js";
import { actionClass, authorizeSessionAction } from "../session-authz.js";

const OP1 = { sub: "op1@example.com", name: "Op1", username: "op1", provider: "github", exp: 0 } as any;
const OP2 = { sub: "op2@example.com", name: "Op2", username: "op2", provider: "github", exp: 0 } as any;

// Every bridge COMMAND form parseSendPrompt recognizes (the surface the bridge
// EXECUTES) + the raw passthrough forms (co-drive).
const COMMAND_TEXTS = [
  "!ls -la",             // bash (host shell, in-context)
  "!! touch /tmp/pwned", // bash (host shell, excluded)
  "/quit",               // shutdown
  "/exit",               // shutdown
  "/reload",             // reload (kill+respawn)
  "/new",                // spawn
  "/model anthropic/claude-haiku-4-5", // model switch
  "/compact",            // compact
  "/compact focus here", // compact w/ args
  "/skill:foo",          // generic slash (extension command dispatch)
  "/roles",              // generic slash
];
const RAW_TEXTS = [
  "explain this code",
  "look at src/index.ts",
  "!",       // empty bash → passthrough (bridge sends as plain message)
  "!!",      // empty bash → passthrough
  "/skill:foo\nmore context", // multi-line slash → passthrough (template expand)
];

// ───────────────────────────────────────────────────────────────────────────
// (unit) the SHARED classifier — command-form vs raw, derived from parseSendPrompt
// ───────────────────────────────────────────────────────────────────────────
describe("Build 1b PUSHBACK-3 FIX-P3-1 — shared send_prompt command classification", () => {
  it("prompt-command is an enumerated OPERATOR-ONLY action", () => {
    expect(actionClass("prompt-command")).toBe("operator-only");
  });

  it("every bridge COMMAND form classifies as the operator-only prompt-command", () => {
    // Red-arm: make isBridgeCommandText always return false → these become
    // send_prompt (co-drive) → RED. Single-source: derived from parseSendPrompt.
    for (const text of COMMAND_TEXTS) {
      expect(isBridgeCommandText(text), `"${text}" must be a command form`).toBe(true);
      expect(classifySendPromptAction(text), `"${text}" → prompt-command`).toBe("prompt-command");
    }
  });

  it("every raw passthrough prompt classifies as the co-drive send_prompt", () => {
    for (const text of RAW_TEXTS) {
      expect(isBridgeCommandText(text), `"${text}" must be raw`).toBe(false);
      expect(classifySendPromptAction(text), `"${text}" → send_prompt`).toBe("send_prompt");
    }
  });

  it("the server classifier MATCHES the bridge parser by construction (no drift)", () => {
    // The load-bearing close-by-construction property: the server's command
    // decision IS `parseSendPrompt(text).type !== "passthrough"`. A bridge
    // command the server does not classify = an escape; this pins them equal.
    for (const text of [...COMMAND_TEXTS, ...RAW_TEXTS]) {
      const isCommand = parseSendPrompt(text).type !== "passthrough";
      expect(classifySendPromptAction(text) === "prompt-command").toBe(isCommand);
    }
  });

  it("authorizeSessionAction on prompt-command: op-2 REFUSED, op-1 ALLOWED, service REFUSED", () => {
    const ou = ["op1@example.com"];
    // op-2 command-form (prompt-command) → operator-only refusal.
    const d1 = authorizeSessionAction({ actor: { kind: "human", principal: OP2 }, action: "prompt-command", requireBrowserAuth: true, operatorUsers: ou });
    expect(d1.allowed).toBe(false);
    expect(d1.reason).toBe("operator-only");
    // op-1 command-form → allowed (operator).
    const d2 = authorizeSessionAction({ actor: { kind: "human", principal: OP1 }, action: "prompt-command", requireBrowserAuth: true, operatorUsers: ou });
    expect(d2.allowed).toBe(true);
    // op-2 raw prompt (send_prompt, co-drive) → allowed.
    const d3 = authorizeSessionAction({ actor: { kind: "human", principal: OP2 }, action: "send_prompt", requireBrowserAuth: true, operatorUsers: ou });
    expect(d3.allowed).toBe(true);
  });

  it("flag OFF: a command-form classifies but authorizes allowed (byte-unchanged single-op)", () => {
    // The classifier still returns prompt-command, but the gate no-ops when OFF.
    expect(classifySendPromptAction("/quit")).toBe("prompt-command");
    const d = authorizeSessionAction({ actor: { kind: "human", principal: null }, action: "prompt-command", requireBrowserAuth: false });
    expect(d.allowed).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Real WS + REST seams — the actual op-2 bypass closed on BOTH
// ───────────────────────────────────────────────────────────────────────────
describe("Build 1b PUSHBACK-3 FIX-P3-1 + FIX-P3-4 — real WS + REST seams", () => {
  let testDir: string;
  let configFile: string;
  let origHome: string;
  let handle: TestServerHandle | undefined;
  const SECRET = "b1b-fix3-sendprompt-secret";
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

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "b1b-fix3-"));
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

  async function bootMultiOp(operatorUsers: string[]) {
    fs.writeFileSync(configFile, JSON.stringify({ auth: { secret: SECRET, requireBrowserAuth: true, operatorUsers } }));
    const loaded = loadConfig();
    handle = await createTestServer({ authConfig: loaded.auth, resolvedTrustedNetworks: loaded.resolvedTrustedNetworks });
    return handle;
  }
  function cookie(sub: string) {
    return `${COOKIE_NAME}=${signToken({ sub, name: "N", username: sub.split("@")[0], provider: "github" }, SECRET)}`;
  }
  /** Register a session + connect a fake bridge that records forwarded messages. */
  async function bridgeWithSession(h: TestServerHandle, sessionId: string) {
    h.server.sessionManager.register({ id: sessionId, cwd: "/tmp", source: "tui" as const, startedAt: Date.now() });
    const bridge = new WebSocket(`ws://localhost:${h.piPort}`);
    await tryOpen(bridge);
    bridge.send(JSON.stringify({ type: "session_register", sessionId, cwd: "/tmp", source: "tui", name: sessionId }));
    bridge.send(JSON.stringify({ type: "replay_complete", sessionId }));
    const inbox: any[] = [];
    bridge.on("message", (raw) => { try { inbox.push(JSON.parse(raw.toString())); } catch { /* noop */ } });
    await delay(150);
    return { bridge, inbox };
  }
  async function connectBrowser(h: TestServerHandle, sub: string) {
    const ws = new WebSocket(`ws://localhost:${h.httpPort}/ws`, { headers: { Cookie: cookie(sub) } });
    expect(await tryOpen(ws)).toBe(true);
    await delay(100);
    return ws;
  }

  // ── FIX-P3-1 WS: op-2 command-form send_prompt REFUSED, raw ALLOWED ────────
  it("WS: op-2 command-form send_prompt (/quit, /model, /new, /compact, !, !!) is REFUSED (no bridge forward); raw is co-drive", async () => {
    // Red-arm: neuter the command classification (isBridgeCommandText → false, or
    // drop the authorizeSendPrompt gate) → op-2's /quit reaches the bridge as a
    // send_prompt whose text the bridge parses to `shutdown` → the "must NOT
    // forward" assertion fails.
    const h = await bootMultiOp(["op1@example.com"]);
    const { bridge, inbox } = await bridgeWithSession(h, "sCmd");
    const op2 = await connectBrowser(h, "op2@example.com");

    for (const text of ["/quit", "/exit", "/new", "/compact", "/model anthropic/x", "!ls", "!! touch /tmp/pwned", "/skill:foo"]) {
      op2.send(JSON.stringify({ type: "send_prompt", sessionId: "sCmd", text }));
    }
    await delay(300);
    const forwardedCmd = inbox.find((m) => m.type === "send_prompt");
    expect(forwardedCmd, "op-2 command-form send_prompt must NOT reach the bridge").toBeUndefined();

    // A raw prompt from op-2 IS co-drive → forwarded.
    op2.send(JSON.stringify({ type: "send_prompt", sessionId: "sCmd", text: "explain this function" }));
    await delay(200);
    expect(inbox.find((m) => m.type === "send_prompt" && m.text === "explain this function"),
      "op-2 raw prompt (co-drive) must reach the bridge").toBeDefined();

    try { op2.close(); } catch { /* noop */ }
    bridge.close();
    await delay(50);
  }, 20000);

  it("WS: op-1 (operator) command-form send_prompt IS allowed (reaches the bridge)", async () => {
    const h = await bootMultiOp(["op1@example.com"]);
    const { bridge, inbox } = await bridgeWithSession(h, "sCmd1");
    const op1 = await connectBrowser(h, "op1@example.com");
    op1.send(JSON.stringify({ type: "send_prompt", sessionId: "sCmd1", text: "!! echo hi" }));
    await delay(200);
    expect(inbox.find((m) => m.type === "send_prompt" && m.text === "!! echo hi"),
      "op-1 command-form send_prompt must reach the bridge").toBeDefined();
    try { op1.close(); } catch { /* noop */ }
    bridge.close();
    await delay(50);
  }, 20000);

  // ── FIX-P3-1 REST: op-2 command-form /prompt → 403; raw → allowed ──────────
  it("REST: op-2 command-form POST /prompt is 403 operator-only; raw is co-drive (2xx path)", async () => {
    // Red-arm: revert /prompt to `gate("send_prompt")` (drop makeRestPromptGate)
    // → op-2's {text:"/quit"} passes the co-drive gate → not 403 → RED.
    const h = await bootMultiOp(["op1@example.com"]);
    await bridgeWithSession(h, "sRest");
    for (const text of ["/quit", "/reload", "/model anthropic/x", "!! touch /tmp/x"]) {
      const res = await fetch(`http://localhost:${h.httpPort}/api/session/sRest/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie("op2@example.com") },
        body: JSON.stringify({ text }),
      });
      expect(res.status, `op-2 REST command "${text}" must be 403`).toBe(403);
      expect((await res.json()).reason).toBe("operator-only");
    }
    // Raw prompt → co-drive: NOT gate-refused (the bridge forwards → 200).
    const rawRes = await fetch(`http://localhost:${h.httpPort}/api/session/sRest/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie("op2@example.com") },
      body: JSON.stringify({ text: "explain this" }),
    });
    expect([401, 403], `op-2 REST raw prompt must NOT be gate-refused (got ${rawRes.status})`).not.toContain(rawRes.status);
  }, 20000);

  it("REST: op-1 (operator) command-form POST /prompt is NOT gate-refused", async () => {
    const h = await bootMultiOp(["op1@example.com"]);
    await bridgeWithSession(h, "sRest1");
    const res = await fetch(`http://localhost:${h.httpPort}/api/session/sRest1/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie("op1@example.com") },
      body: JSON.stringify({ text: "/reload" }),
    });
    expect([401, 403], `op-1 REST command must NOT be gate-refused (got ${res.status})`).not.toContain(res.status);
  }, 20000);

  // ── FIX-P3-4 WS: op-2 send_prompt to an ENDED session → resume REFUSED ─────
  it("WS: op-2 raw send_prompt to an ENDED session is REFUSED (no auto-resume spawn); op-1 reaches the resume", async () => {
    // Red-arm: remove the operator-only `resume` re-auth at the ended-session
    // branch → op-2's send_prompt-to-ended reaches spawnPiSession (the resume
    // effect) → the "unauthorized" assertion fails. Observation model: the ended
    // session has NO sessionFile, so the resume path bails at its sessionFile
    // guard AFTER the re-auth; op-2 gets send_prompt_failed{unauthorized} and
    // never records a pending resume, op-1 passes the re-auth (then bails on the
    // absent sessionFile — no real spawn).
    const h = await bootMultiOp(["op1@example.com"]);
    // Register an ENDED session with NO sessionFile (so no real spawn happens).
    h.server.sessionManager.register({ id: "sEnded", cwd: "/tmp", source: "tui" as const, startedAt: Date.now() });
    h.server.sessionManager.update("sEnded", { status: "ended" });

    const op2 = await connectBrowser(h, "op2@example.com");
    const op2Inbox: any[] = [];
    op2.on("message", (raw) => { try { op2Inbox.push(JSON.parse(raw.toString())); } catch { /* noop */ } });
    op2.send(JSON.stringify({ type: "send_prompt", sessionId: "sEnded", text: "please continue" }));
    await delay(300);
    const failed = op2Inbox.find((m) => m.type === "send_prompt_failed" && m.reason === "unauthorized");
    expect(failed, "op-2 send_prompt to an ended session must be REFUSED (resume is operator-only)").toBeDefined();
    // The session must NOT have flipped to `resuming` (the auto-resume never ran).
    expect(h.server.sessionManager.get("sEnded")?.resuming ?? false,
      "op-2 refused resume must not mark the session resuming").toBe(false);

    // op-1 (operator) reaches the resume: it is NOT refused unauthorized (then
    // bails on the absent sessionFile — no real spawn, no crash).
    const op1 = await connectBrowser(h, "op1@example.com");
    const op1Inbox: any[] = [];
    op1.on("message", (raw) => { try { op1Inbox.push(JSON.parse(raw.toString())); } catch { /* noop */ } });
    op1.send(JSON.stringify({ type: "send_prompt", sessionId: "sEnded", text: "please continue" }));
    await delay(300);
    expect(op1Inbox.find((m) => m.type === "send_prompt_failed" && m.reason === "unauthorized"),
      "op-1 send_prompt to an ended session must NOT be refused unauthorized").toBeUndefined();

    try { op1.close(); op2.close(); } catch { /* noop */ }
    await delay(50);
  }, 20000);

  it("WS: op-2 raw send_prompt to an ALIVE session is co-drive (unaffected by the ended-session resume gate)", async () => {
    const h = await bootMultiOp(["op1@example.com"]);
    const { bridge, inbox } = await bridgeWithSession(h, "sAlive");
    const op2 = await connectBrowser(h, "op2@example.com");
    op2.send(JSON.stringify({ type: "send_prompt", sessionId: "sAlive", text: "keep going" }));
    await delay(200);
    expect(inbox.find((m) => m.type === "send_prompt" && m.text === "keep going"),
      "op-2 raw prompt on an ALIVE session must still co-drive").toBeDefined();
    try { op2.close(); } catch { /* noop */ }
    bridge.close();
    await delay(50);
  }, 20000);

  // ── flag-OFF byte-unchanged: command-forms forward as today ───────────────
  it("flag-OFF: a command-form send_prompt forwards unchanged (byte-unchanged single-op)", async () => {
    fs.writeFileSync(configFile, JSON.stringify({ port: 8000 }));
    const loaded = loadConfig();
    expect(loaded.auth).toBeUndefined();
    handle = await createTestServer({ authConfig: loaded.auth, resolvedTrustedNetworks: loaded.resolvedTrustedNetworks });
    const { bridge, inbox } = await bridgeWithSession(handle, "sOff");
    const ws = new WebSocket(`ws://localhost:${handle.httpPort}/ws`);
    expect(await tryOpen(ws)).toBe(true);
    await delay(100);
    ws.send(JSON.stringify({ type: "send_prompt", sessionId: "sOff", text: "!! echo hi" }));
    await delay(200);
    expect(inbox.find((m) => m.type === "send_prompt" && m.text === "!! echo hi"),
      "flag-OFF command-form send_prompt must forward unchanged").toBeDefined();
    try { ws.close(); } catch { /* noop */ }
    bridge.close();
    await delay(50);
  }, 20000);
});
