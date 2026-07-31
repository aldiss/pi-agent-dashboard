/**
 * Build-1b WS-CLOSURE red-arm suite.
 *
 * Proves the WS session-write seam is closed through the SAME central
 * `authorizeSessionAction` chokepoint the REST seam + the send-seam use, with
 * operator-only enforcement CLOSE-BY-CONSTRUCTION (both seams derive their
 * operator-only class from the ONE `SESSION_WRITE_ACTION_CLASS` source). Every
 * case is RED-ARM (plant instructions in each block header): plant → FAIL →
 * restore → PASS.
 *
 * Observation model: the central WS gate runs BEFORE dispatch, so a refused
 * message NEVER reaches its handler = NO side effect. We observe the side effect
 * (or its absence) directly:
 *   - `shutdown` → `sessionManager.unregister` + `session_removed` broadcast +
 *     a `shutdown` forward to the bridge. Refused ⇒ session STILL registered +
 *     no bridge forward.
 *   - `abort` / `flow_control` / `set_model` → a forward to the bridge
 *     (`piGateway.sendToSession`). Refused ⇒ no bridge forward.
 *
 * (a) per-seam enforcement, (b) coverage across BOTH seams, (c) drift-proof.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { WebSocket } from "ws";
import { loadConfig } from "@blackbelt-technology/pi-dashboard-shared/config.js";
import { signToken, COOKIE_NAME } from "../auth.js";
import { createTestServer, type TestServerHandle } from "../test-support/test-server.js";
import {
  SESSION_WRITE_ACTION_CLASS,
  WS_SESSION_WRITE_MESSAGE_ACTION,
  wsMessageAction,
  actionClass,
} from "../session-authz.js";
import { authorizeWsMessage } from "../ws-session-gate.js";

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
// (b) + (c) — coverage + drift-proof (pure, no server)
// ───────────────────────────────────────────────────────────────────────────
describe("Build 1b WS-closure (b) coverage — every operator-only action gated on BOTH seams", () => {
  // The operator-only actions that have a WS message-type MUST each appear in
  // the WS registry (else that operator-only action is ungated on the WS seam).
  // Red-arm: remove a row from WS_SESSION_WRITE_MESSAGE_ACTION (e.g. `shutdown`)
  // → that operator-only action is no longer WS-gated → this test RED.
  it("every WS session-write message-type maps to an enumerated action (WS arm ⊆ the ONE source)", () => {
    for (const [wsType, action] of Object.entries(WS_SESSION_WRITE_MESSAGE_ACTION)) {
      expect(actionClass(action), `${wsType}→${action} must be enumerated`).toBeDefined();
    }
  });

  it("every operator-only action that has a WS seam is WS-gated (no ungated operator-only WS handler)", () => {
    // The operator-only actions reachable over WS (the browser can send these
    // message-types). Each MUST be in the WS registry. If a new operator-only
    // WS handler is added without a registry row, this set diverges → RED.
    // WS-registry action VALUES (the narrow subset the WS seam gates) — NOT the
    // wider SessionWriteAction (which also carries send_prompt / prompt-command,
    // classified on other seams). Typing the list as the registry value-union
    // keeps `gatedActions.has(a)` sound without loosening `actionClass`'s param
    // type (PUSHBACK-4 FIX-P4-1b, was TS2345).
    const OPERATOR_ONLY_WS_ACTIONS: Array<
      (typeof WS_SESSION_WRITE_MESSAGE_ACTION)[keyof typeof WS_SESSION_WRITE_MESSAGE_ACTION]
    > = [
      "shutdown", "flow-control", "kill_process", "force_kill", "rename",
      "hide", "unhide", "attach-proposal", "detach-proposal", "resume",
      "spawn", "model", "thinking-level",
    ];
    const gatedActions = new Set(Object.values(WS_SESSION_WRITE_MESSAGE_ACTION));
    for (const a of OPERATOR_ONLY_WS_ACTIONS) {
      expect(actionClass(a), `${a} must be operator-only`).toBe("operator-only");
      expect(gatedActions.has(a), `operator-only action ${a} must be WS-gated`).toBe(true);
    }
  });

  it("the WS `abort` action matches the REST `abort` class (both seams share one entry)", () => {
    // The directive: the two seams' `abort` MUST match. Both derive from the ONE
    // SESSION_WRITE_ACTION_CLASS.abort — so they cannot diverge by construction.
    expect(wsMessageAction("abort")).toBe("abort");
    expect(actionClass("abort")).toBe("co-drive");
  });
});

describe("Build 1b WS-closure (c) drift-proof — one source, both seams auto-gate", () => {
  it("the WS registry values are ALL keys of the ONE SESSION_WRITE_ACTION_CLASS source", () => {
    // Red-arm: point a WS registry row at an action token NOT in the enum (a
    // per-seam duplicate source) → this fails (TS `satisfies` also catches it at
    // compile time). Proves the WS seam DERIVES from the one source, not a copy.
    const enumKeys = new Set(Object.keys(SESSION_WRITE_ACTION_CLASS));
    for (const action of Object.values(WS_SESSION_WRITE_MESSAGE_ACTION)) {
      expect(enumKeys.has(action), `${action} must be a key of SESSION_WRITE_ACTION_CLASS`).toBe(true);
    }
  });

  it("a NEW operator-only action added to the ONE source is auto-classified on the WS lookup path", () => {
    // `wsMessageAction` + `actionClass` are the WS seam's only classification
    // path. Adding an operator-only action to the enum + a registry row makes it
    // operator-only on the WS seam with zero per-handler edits. We assert the
    // just-added process-control actions demonstrate this (they were added in
    // WS-closure and are auto-gated via the same lookup as every other action).
    expect(actionClass(wsMessageAction("kill_process")!)).toBe("operator-only");
    expect(actionClass(wsMessageAction("force_kill")!)).toBe("operator-only");
    // And a co-drive action stays co-drive on the same path.
    expect(actionClass(wsMessageAction("abort")!)).toBe("co-drive");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (a) per-seam enforcement — real-server WS
// ───────────────────────────────────────────────────────────────────────────
describe("Build 1b WS-closure (a) — operator-only enforcement over the real WS seam", () => {
  let testDir: string;
  let configFile: string;
  let origHome: string;
  let handle: TestServerHandle | undefined;
  const SECRET = "build1b-ws-closure-secret";

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "b1b-ws-"));
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

  /** Boot bridge + register a session; return the bridge + its inbox. */
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
    await delay(100); // drain snapshot
    return ws;
  }

  // ── op-2 shutdown REFUSED / op-1 shutdown ALLOWED ────────────────────────
  it("op-2 (non-operator) WS shutdown is REFUSED (no side effect); op-1 WS shutdown is ALLOWED", async () => {
    // Red-arm: remove the central WS gate (or classify shutdown co-drive) →
    // op-2's shutdown forwards to the bridge + ends the session → this fails.
    // Observable: the `shutdown` FORWARD to the bridge (the clean per-actor
    // signal). `unregister` sets status="ended" (does NOT delete), so we assert
    // status too — but the forward is the load-bearing proof.
    const h = await bootMultiOp(["op1@example.com"]);
    const { bridge, inbox } = await bridgeWithSession(h, "sWsShut");

    // op-2 attempts shutdown → REFUSED: no forward, session not ended.
    const op2 = await connectBrowser(h, "op2@example.com");
    op2.send(JSON.stringify({ type: "shutdown", sessionId: "sWsShut" }));
    await delay(250);
    expect(inbox.find((m) => m.type === "shutdown"), "op-2 shutdown must NOT reach the bridge").toBeUndefined();
    expect(h.server.sessionManager.get("sWsShut")?.status, "op-2 shutdown must NOT end the session").not.toBe("ended");

    // op-1 attempts shutdown → ALLOWED: forward reaches the bridge + session ends.
    const op1 = await connectBrowser(h, "op1@example.com");
    op1.send(JSON.stringify({ type: "shutdown", sessionId: "sWsShut" }));
    await delay(250);
    expect(inbox.find((m) => m.type === "shutdown"), "op-1 shutdown must reach the bridge").toBeDefined();
    expect(h.server.sessionManager.get("sWsShut")?.status, "op-1 shutdown must end the session").toBe("ended");

    try { op1.close(); op2.close(); } catch { /* noop */ }
    bridge.close();
    await delay(50);
  }, 20000);

  // ── borderline abort → CO-DRIVE (op-2 allowed) ───────────────────────────
  it("borderline abort is CO-DRIVE: op-2's WS abort IS forwarded (safety emergency-stop)", async () => {
    // Red-arm: reclassify abort operator-only → op-2's abort is refused → the
    // forward is absent → this fails. (The two seams share the one abort entry.)
    const h = await bootMultiOp(["op1@example.com"]);
    const { bridge, inbox } = await bridgeWithSession(h, "sWsAbort");
    const op2 = await connectBrowser(h, "op2@example.com");
    op2.send(JSON.stringify({ type: "abort", sessionId: "sWsAbort" }));
    await delay(250);
    expect(inbox.find((m) => m.type === "abort"), "op-2 abort (co-drive) must reach the bridge").toBeDefined();
    try { op2.close(); } catch { /* noop */ }
    bridge.close();
    await delay(50);
  }, 20000);

  // ── borderline flow_control + resume → OPERATOR-ONLY (op-2 refused) ───────
  it("borderline flow_control + resume_session are OPERATOR-ONLY: op-2 is REFUSED", async () => {
    // Red-arm: classify flow-control/resume co-drive → op-2's flow_control
    // forwards → this fails.
    const h = await bootMultiOp(["op1@example.com"]);
    const { bridge, inbox } = await bridgeWithSession(h, "sWsFlow");
    const op2 = await connectBrowser(h, "op2@example.com");

    op2.send(JSON.stringify({ type: "flow_control", sessionId: "sWsFlow", action: "toggle_autonomous" }));
    await delay(200);
    expect(inbox.find((m) => m.type === "flow_control"), "op-2 flow_control (operator-only) must NOT reach the bridge").toBeUndefined();

    // resume_session on an ENDED session would spawn; refused → no resume_result success.
    const results: any[] = [];
    op2.on("message", (raw) => { try { results.push(JSON.parse(raw.toString())); } catch { /* noop */ } });
    op2.send(JSON.stringify({ type: "resume_session", sessionId: "sWsFlow", mode: "continue", requestId: "r1" }));
    await delay(250);
    const resumeResult = results.find((m) => m.type === "resume_result" && m.requestId === "r1");
    expect(resumeResult?.success, "op-2 resume must be refused").toBe(false);

    try { op2.close(); } catch { /* noop */ }
    bridge.close();
    await delay(50);
  }, 20000);

  // ── op-1 (operator) allowed the operator-only actions ────────────────────
  it("op-1 (operator) WS flow_control IS forwarded (operator allowed)", async () => {
    const h = await bootMultiOp(["op1@example.com"]);
    const { bridge, inbox } = await bridgeWithSession(h, "sWsOp1Flow");
    const op1 = await connectBrowser(h, "op1@example.com");
    op1.send(JSON.stringify({ type: "flow_control", sessionId: "sWsOp1Flow", action: "toggle_autonomous" }));
    await delay(250);
    expect(inbox.find((m) => m.type === "flow_control"), "op-1 flow_control must reach the bridge").toBeDefined();
    try { op1.close(); } catch { /* noop */ }
    bridge.close();
    await delay(50);
  }, 20000);

  // ── set_model (via the default→handlePiGatewayForward path) is WS-gated ───
  it("op-2 WS set_model (operator-only, forwarded-path) is REFUSED; op-1 is ALLOWED", async () => {
    // Red-arm: omit set_model from WS_SESSION_WRITE_MESSAGE_ACTION → op-2's
    // set_model forwards through the default case ungated → this fails. (This is
    // the exact per-instance-drift class the WS-gap was — the forwarded path.)
    const h = await bootMultiOp(["op1@example.com"]);
    const { bridge, inbox } = await bridgeWithSession(h, "sWsModel");

    const op2 = await connectBrowser(h, "op2@example.com");
    op2.send(JSON.stringify({ type: "set_model", sessionId: "sWsModel", provider: "anthropic", modelId: "x" }));
    await delay(200);
    expect(inbox.find((m) => m.type === "set_model"), "op-2 set_model must NOT reach the bridge").toBeUndefined();

    const op1 = await connectBrowser(h, "op1@example.com");
    op1.send(JSON.stringify({ type: "set_model", sessionId: "sWsModel", provider: "anthropic", modelId: "x" }));
    await delay(200);
    expect(inbox.find((m) => m.type === "set_model"), "op-1 set_model must reach the bridge").toBeDefined();

    try { op1.close(); op2.close(); } catch { /* noop */ }
    bridge.close();
    await delay(50);
  }, 20000);

  // ── flag-OFF WS byte-unchanged ───────────────────────────────────────────
  it("flag OFF: an anonymous WS shutdown behaves exactly as today (side effect runs)", async () => {
    // No auth block → single-op. The WS gate no-ops; shutdown runs as today.
    fs.writeFileSync(configFile, JSON.stringify({ port: 8000 }));
    const loaded = loadConfig();
    expect(loaded.auth).toBeUndefined();
    handle = await createTestServer({ authConfig: loaded.auth, resolvedTrustedNetworks: loaded.resolvedTrustedNetworks });
    const { bridge, inbox } = await bridgeWithSession(handle, "sWsOff");
    const ws = new WebSocket(`ws://localhost:${handle.httpPort}/ws`);
    expect(await tryOpen(ws)).toBe(true);
    await delay(100);
    ws.send(JSON.stringify({ type: "shutdown", sessionId: "sWsOff" }));
    await delay(250);
    // Byte-unchanged: the shutdown ran (forwarded + session ended).
    expect(inbox.find((m) => m.type === "shutdown")).toBeDefined();
    expect(handle.server.sessionManager.get("sWsOff")?.status).toBe("ended");
    try { ws.close(); } catch { /* noop */ }
    bridge.close();
    await delay(50);
  }, 20000);

  // ── PUSHBACK-1 Fix 1a: the found-missed reachable session-write handlers ───
  // These were REACHABLE session-write cases (browser-gateway.ts) left ungated:
  // op-2 could invoke role_set/flow_management/role_preset_* UNGATED (the op-2
  // bypass the dl-5825 dual-review caught). role_set carries a modelId (changes
  // the session role/model = the same operator-level effect as set_model).
  it("op-2 WS role_set is REFUSED (no forward); op-1 role_set is ALLOWED", async () => {
    // Red-arm: remove role_set from WS_SESSION_WRITE_MESSAGE_ACTION → op-2's
    // role_set forwards to the bridge ungated → this fails.
    const h = await bootMultiOp(["op1@example.com"]);
    const { bridge, inbox } = await bridgeWithSession(h, "sWsRole");

    const op2 = await connectBrowser(h, "op2@example.com");
    op2.send(JSON.stringify({ type: "role_set", sessionId: "sWsRole", role: "architect", modelId: "anthropic/x" }));
    await delay(200);
    expect(inbox.find((m) => m.type === "role_set"), "op-2 role_set (operator-only) must NOT reach the bridge").toBeUndefined();

    const op1 = await connectBrowser(h, "op1@example.com");
    op1.send(JSON.stringify({ type: "role_set", sessionId: "sWsRole", role: "architect", modelId: "anthropic/x" }));
    await delay(200);
    expect(inbox.find((m) => m.type === "role_set"), "op-1 role_set must reach the bridge").toBeDefined();

    try { op1.close(); op2.close(); } catch { /* noop */ }
    bridge.close();
    await delay(50);
  }, 20000);

  it("op-2 WS flow_management + role_preset_save/delete/load are REFUSED (operator-only mutations)", async () => {
    // Red-arm: remove any of these rows from WS_SESSION_WRITE_MESSAGE_ACTION →
    // op-2's forward reaches the bridge ungated → this fails. role_preset_load
    // APPLIES a saved preset (= role_set effect), so it is operator-only too.
    const h = await bootMultiOp(["op1@example.com"]);
    const { bridge, inbox } = await bridgeWithSession(h, "sWsMut");
    const op2 = await connectBrowser(h, "op2@example.com");

    op2.send(JSON.stringify({ type: "flow_management", sessionId: "sWsMut", action: "delete", flowName: "f" }));
    op2.send(JSON.stringify({ type: "role_preset_save", sessionId: "sWsMut", presetName: "p" }));
    op2.send(JSON.stringify({ type: "role_preset_delete", sessionId: "sWsMut", presetName: "p" }));
    op2.send(JSON.stringify({ type: "role_preset_load", sessionId: "sWsMut", presetName: "p" }));
    await delay(250);
    for (const t of ["flow_management", "role_preset_save", "role_preset_delete", "role_preset_load"]) {
      expect(inbox.find((m) => m.type === t), `op-2 ${t} (operator-only) must NOT reach the bridge`).toBeUndefined();
    }

    try { op2.close(); } catch { /* noop */ }
    bridge.close();
    await delay(50);
  }, 20000);

  it("op-2 WS request_roles (co-drive READ) IS forwarded — a bounded co-driver may list roles", async () => {
    // Red-arm: misclassify request_roles operator-only → op-2's request_roles is
    // refused → the forward is absent → this fails. request_roles is a READ (no
    // presetName, no mutation), so it is co-drive.
    const h = await bootMultiOp(["op1@example.com"]);
    const { bridge, inbox } = await bridgeWithSession(h, "sWsReqRoles");
    const op2 = await connectBrowser(h, "op2@example.com");
    op2.send(JSON.stringify({ type: "request_roles", sessionId: "sWsReqRoles" }));
    await delay(200);
    expect(inbox.find((m) => m.type === "request_roles"), "op-2 request_roles (co-drive) must reach the bridge").toBeDefined();
    try { op2.close(); } catch { /* noop */ }
    bridge.close();
    await delay(50);
  }, 20000);
});

// ───────────────────────────────────────────────────────────────────────────
// FOLD-A — the WS gate FAILS-CLOSED on an unmapped session-write-shaped type
// ───────────────────────────────────────────────────────────────────────────
describe("Build 1b PUSHBACK-1 FOLD-A — the WS gate is default-DENY on unmapped types (flag ON)", () => {
  const OP = { sub: "op@example.com", name: "Op", username: "op", provider: "github", exp: 0 } as any;
  function ctx(requireBrowserAuth: boolean): any {
    return { principal: OP, requireBrowserAuth };
  }

  it("an UNMAPPED type is REFUSED when the flag is ON (unclassified-action, not pass-through)", () => {
    // Red-arm: revert ws-session-gate's non-gated branch to always
    // `{passThrough:true,allowed:true}` → this unmapped type passes → RED. This
    // is the structural root of the WS-gap: unmapped default was fail-OPEN.
    const d = authorizeWsMessage({ type: "totally_new_forward", sessionId: "s" } as any, ctx(true));
    expect(d.passThrough).toBe(false);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("unclassified-action");
  });

  it("the SAME unmapped type passes through when the flag is OFF (byte-unchanged)", () => {
    const d = authorizeWsMessage({ type: "totally_new_forward", sessionId: "s" } as any, ctx(false));
    expect(d.passThrough).toBe(true);
    expect(d.allowed).toBe(true);
  });

  it("an allowlisted read/co-drive passthrough is allowed when the flag is ON (ping/subscribe/fetch_content)", () => {
    // NOTE: ui_management is NO LONGER a blanket passthrough (PUSHBACK-2
    // FIX-P2-1 — it is action-gated; see build1b-fix2-ui-management.test.ts).
    // NOTE: prompt_response + prompt_rendered are NO LONGER passthrough (Pete
    // dl-13358 B2 — they are operator-only gated; the guest-denied /
    // operator-accepted / no-principal proofs live in cell-access-authz.test.ts,
    // which supplies the full session-resolving ctx the gate now needs for a
    // session-scoped operator-only action).
    for (const type of ["ping", "subscribe", "fetch_content"]) {
      const d = authorizeWsMessage({ type, sessionId: "s" } as any, ctx(true));
      expect(d.passThrough, `${type} must pass through`).toBe(true);
      expect(d.allowed, `${type} must be allowed`).toBe(true);
    }
  });

  it("a host-deferred forward passes through when the flag is ON (scope-honest, Build-1c-deferred)", () => {
    for (const type of ["create_terminal", "kill_terminal", "openspec_bulk_archive"]) {
      const d = authorizeWsMessage({ type, sessionId: "s" } as any, ctx(true));
      expect(d.passThrough, `${type} must pass through (deferred, not gated)`).toBe(true);
      expect(d.allowed, `${type} must be allowed (deferred)`).toBe(true);
    }
  });
});
