/**
 * Build-1b PUSHBACK-2 FIX-P2-4 (NEW MAJOR-1) red-arm suite — the `/reload`
 * interception is an operator-only kill+respawn, not a co-drive send_prompt.
 *
 * The dl-5825 re-review found (own-hand): `send_prompt` is CO-DRIVE (op-2 allowed at
 * session-action-handler.ts). Immediately after the co-drive gate passes,
 * `shouldInterceptReload(msg)` → `handleHeadlessReload(msg, ctx)` →
 * `killPidWithGroup(pid,"SIGTERM")` + respawn, with NO operator check. So op-2
 * (a bounded co-driver, refused kill_process/force_kill on the WS seam) could
 * SIGTERM+respawn a headless pi via `send_prompt {text:"/reload"}`.
 *
 * The fix: re-authorize the DISTINCT operator-only `reload` action through the
 * ONE `authorizeSessionAction` chokepoint BEFORE `handleHeadlessReload` — do NOT
 * ride the co-drive `send_prompt` verdict.
 *
 * Observation model (no real spawn): a headless PID is registered for the
 * session, so `shouldInterceptReload` is true. The session has NO `sessionFile`,
 * so `handleHeadlessReload` bails at its sessionFile guard — emitting a single
 * `command_feedback {status:"error","No session file …"}` and returning BEFORE
 * any kill/spawn. So the load-bearing discriminator is "did the interception run
 * at all":
 *   - REFUSED (op-2) ⇒ NO `command_feedback` broadcast at all (the handler never
 *     ran) + a `send_prompt_failed {reason:"unauthorized"}` to the browser + the
 *     headless PID is NOT killed.
 *   - ALLOWED (op-1) ⇒ the interception runs: a `command_feedback` IS broadcast
 *     (the operator reached the kill+respawn primitive; it then bails on the
 *     absent sessionFile — no real spawn).
 *
 * Every case is RED-ARM (plant instructions in each block header).
 */
import { describe, it, expect } from "vitest";
import { handleSendPrompt } from "../browser-handlers/session-action-handler.js";

const OP1 = { sub: "op1@example.com", name: "Op1", username: "op1", provider: "github", exp: 0 } as any;
const OP2 = { sub: "op2@example.com", name: "Op2", username: "op2", provider: "github", exp: 0 } as any;

/**
 * Build a mock ctx whose headless registry reports a tracked PID for the
 * session (so `/reload` is intercepted) and whose session has NO sessionFile
 * (so the reload handler bails right after its first `command_feedback` — no
 * real spawn). Records broadcasts, browser sends, and whether the kill fired.
 */
function makeCtx(principal: any, requireBrowserAuth: boolean, operatorUsers?: string[]) {
  const broadcasts: any[] = [];
  const browserSends: any[] = [];
  const session = { id: "sReload", cwd: "/tmp", status: "idle", sessionFile: undefined as string | undefined };
  const ctx: any = {
    ws: {},
    principal,
    requireBrowserAuth,
    ...(operatorUsers ? { operatorUsers } : {}),
    sessionManager: {
      get: (id: string) => (id === "sReload" ? session : undefined),
      update: () => {},
      unregister: () => {},
    },
    headlessPidRegistry: {
      getPid: (id: string) => (id === "sReload" ? 424242 : undefined),
      killBySessionId: () => true,
      register: () => {},
    },
    pendingResumeRegistry: { record: () => {}, consume: () => {} },
    pendingResumeIntents: { record: () => {} },
    pendingDashboardSpawns: new Map(),
    piGateway: { sendToSession: () => true },
    eventStore: { insertEvent: () => 1 },
    broadcast: (m: any) => broadcasts.push(m),
    sendTo: (_ws: any, m: any) => browserSends.push(m),
  };
  return { ctx, broadcasts, browserSends };
}

const reloadMsg = { type: "send_prompt", sessionId: "sReload", text: "/reload" } as any;

describe("Build 1b PUSHBACK-2 FIX-P2-4 — /reload kill+respawn is operator-only", () => {
  it("op-2 (non-operator) /reload on a headless session is REFUSED (no kill, no command_feedback, unauthorized)", async () => {
    // Red-arm: remove the operator-only `reload` re-authorization before
    // handleHeadlessReload → op-2's /reload runs the interception → a
    // `command_feedback {status:"started"}` IS broadcast → the
    // "must NOT broadcast" assertion fails (op-2 reached the kill+respawn).
    const t = makeCtx(OP2, true, ["op1@example.com"]);
    await handleSendPrompt(reloadMsg, t.ctx);

    // No interception side-effects. PUSHBACK-3 NIT-4: the prior
    // `expect(t.killed).toBe(false)` was VACUOUS — the fixture's
    // `sessionFile:undefined` makes `handleHeadlessReload` bail at its sessionFile
    // guard BEFORE `killBySessionId` in EVERY arm (op-1 too), so `killed` is
    // always false regardless of the gate. The LOAD-BEARING discriminator is
    // whether the interception ran AT ALL = whether a `command_feedback` was
    // broadcast (op-1 reaches the handler → emits it; op-2 is refused BEFORE it).
    expect(
      t.broadcasts.find((m) => m.event?.eventType === "command_feedback"),
      "op-2 /reload must NOT emit command_feedback (interception refused before it runs)",
    ).toBeUndefined();
    // The browser is told it was unauthorized.
    const failed = t.browserSends.find((m) => m.type === "send_prompt_failed");
    expect(failed?.reason, "op-2 /reload must be refused unauthorized").toBe("unauthorized");
  });

  it("op-1 (operator) /reload on a headless session is ALLOWED (reaches the kill+respawn primitive)", async () => {
    // op-1 passes the operator-only gate → the interception runs → a
    // command_feedback IS broadcast (the session has no sessionFile, so the
    // handler bails right after — no real spawn).
    const t = makeCtx(OP1, true, ["op1@example.com"]);
    await handleSendPrompt(reloadMsg, t.ctx);

    const feedback = t.broadcasts.find((m) => m.event?.eventType === "command_feedback");
    expect(feedback, "op-1 /reload must reach the interception (command_feedback emitted)").toBeDefined();
    // No unauthorized failure for op-1.
    expect(
      t.browserSends.find((m) => m.type === "send_prompt_failed" && m.reason === "unauthorized"),
      "op-1 /reload must NOT be refused",
    ).toBeUndefined();
  });

  it("flag OFF: /reload behaves exactly as today (interception runs, byte-unchanged)", async () => {
    // Single-op: the gate no-ops, so even a null principal reaches the
    // interception. Red-arm: if the reload gate refused when the flag is OFF, the
    // command_feedback would be absent → this fails.
    const t = makeCtx(null, false);
    await handleSendPrompt(reloadMsg, t.ctx);
    const feedback = t.broadcasts.find((m) => m.event?.eventType === "command_feedback");
    expect(feedback, "flag-OFF /reload must run the interception (byte-unchanged)").toBeDefined();
  });

  it("op-2 non-/reload send_prompt is still co-drive (the reload gate does not over-trigger)", async () => {
    // A normal prompt (not "/reload") on a NON-headless session must still be
    // co-drive for op-2. getPid returns undefined here (no headless pid) so
    // shouldInterceptReload is false and the reload gate is never consulted.
    const broadcasts: any[] = [];
    const forwarded: any[] = [];
    const ctx: any = {
      ws: {},
      principal: OP2,
      requireBrowserAuth: true,
      operatorUsers: ["op1@example.com"],
      sessionManager: { get: () => ({ id: "sLive", cwd: "/tmp", status: "idle" }), update: () => {} },
      headlessPidRegistry: { getPid: () => undefined, register: () => {} },
      pendingResumeRegistry: { record: () => {} },
      pendingResumeIntents: { record: () => {} },
      pendingDashboardSpawns: new Map(),
      piGateway: { sendToSession: (_id: string, m: any) => { forwarded.push(m); return true; } },
      eventStore: { insertEvent: () => 1 },
      broadcast: (m: any) => broadcasts.push(m),
      sendTo: () => {},
    };
    await handleSendPrompt({ type: "send_prompt", sessionId: "sLive", text: "hello" } as any, ctx);
    expect(forwarded.find((m) => m.type === "send_prompt"), "op-2 co-drive prompt must still forward").toBeDefined();
  });
});
