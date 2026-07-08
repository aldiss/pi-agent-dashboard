/**
 * Build 0 v2.1 — binding-chain EXACT-principal test (gate-pushback-1 MINOR close).
 *
 * The v2 integration test proved only that A NON-NULL principal reached the
 * send-seam gate — a wrong-but-non-null principal planted at
 * `browser-gateway.ts:306` still passed it. This file closes that gap: it
 * observes the EXACT decoded `sub` that the send-seam gate receives and asserts
 * it equals the `sub` minted into the connecting cookie.
 *
 * Observation seam: `authorizeSessionAction` is the single chokepoint
 * `handleSendPrompt` calls with `{ actor: { kind:"human", principal: ctx.principal } }`.
 * We `vi.mock` that module boundary to record each call's `actor.principal?.sub`
 * while delegating to the REAL implementation (no behavior change). Because the
 * upgrade gate verifies only the JWT signature (no allowlist), we mint the
 * cookie `sub` as a per-test UNIQUE nonce — so a hardcoded wrong-sub plant at
 * `:306` cannot coincidentally match and the red-arm is decisive.
 *
 * Red-arm (see report §11.9): bind a WRONG sub at `browser-gateway.ts:306`
 * (e.g. `{ ...boundPrincipal, sub: "attacker@evil.com" }`) → this test MUST
 * FAIL (the observed sub ≠ the cookie sub); production code is unchanged/correct.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { WebSocket } from "ws";
import { loadConfig } from "@blackbelt-technology/pi-dashboard-shared/config.js";
import { signToken, COOKIE_NAME } from "../auth.js";
import { createTestServer, type TestServerHandle } from "../test-support/test-server.js";

// Record every actor.principal.sub the send-seam gate is asked to authorize,
// while delegating to the real gate so behavior is unchanged.
const observedGateSubs: Array<string | null | undefined> = [];
vi.mock("../session-authz.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session-authz.js")>();
  return {
    ...actual,
    authorizeSessionAction: (input: Parameters<typeof actual.authorizeSessionAction>[0]) => {
      const actor = input.actor;
      observedGateSubs.push(actor.kind === "human" ? actor.principal?.sub ?? null : undefined);
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

describe("Build 0 v2.1 — the EXACT decoded principal reaches the send-seam gate", () => {
  let testDir: string;
  let configFile: string;
  let origHome: string;
  let handle: TestServerHandle | undefined;

  beforeEach(() => {
    observedGateSubs.length = 0;
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "b0-bindexact-"));
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

  it("the send-seam gate sees the EXACT sub minted into the cookie (not merely a non-null principal)", async () => {
    const SECRET = "integration-secret-exact-sub";
    // Per-test unique sub — a hardcoded wrong-sub plant at :306 cannot match it.
    const UNIQUE_SUB = `op-${process.pid}-${testDir.slice(-8)}@example.com`;

    fs.writeFileSync(configFile, JSON.stringify({
      auth: { secret: SECRET, requireBrowserAuth: true },
    }));
    const loaded = loadConfig();
    expect(loaded.auth?.requireBrowserAuth).toBe(true);

    handle = await createTestServer({
      authConfig: loaded.auth,
      resolvedTrustedNetworks: loaded.resolvedTrustedNetworks,
    });
    const { httpPort, piPort } = handle;

    // Bridge registers a live session so the send has somewhere to go.
    const bridge = new WebSocket(`ws://localhost:${piPort}`);
    await tryOpen(bridge);
    bridge.send(JSON.stringify({ type: "session_register", sessionId: "sExact", cwd: "/tmp", source: "tui", name: "Exact" }));
    bridge.send(JSON.stringify({ type: "replay_complete", sessionId: "sExact" }));
    await delay(150);
    const bridgeInbox: any[] = [];
    bridge.on("message", (raw) => { try { bridgeInbox.push(JSON.parse(raw.toString())); } catch { /* noop */ } });

    // Browser connects with a cookie carrying the UNIQUE sub.
    const token = signToken({ sub: UNIQUE_SUB, name: "Op Exact", username: "opx", provider: "github" }, SECRET);
    const ws = new WebSocket(`ws://localhost:${httpPort}/ws`, {
      headers: { Cookie: `${COOKIE_NAME}=${token}` },
    });
    expect(await tryOpen(ws)).toBe(true);
    await delay(100);

    ws.send(JSON.stringify({ type: "send_prompt", sessionId: "sExact", text: "exact-sub check" }));
    await delay(250);

    // The send actually reached pi (the gate admitted it).
    const forwarded = bridgeInbox.find((m) => m.type === "send_prompt" && m.sessionId === "sExact");
    expect(forwarded).toBeDefined();

    // CORE ASSERTION (the v2.1 close): the send-seam gate observed EXACTLY the
    // decoded sub from the cookie — not merely a non-null principal. A wrong
    // (but non-null) bind at browser-gateway.ts:306 makes this fail.
    expect(observedGateSubs).toContain(UNIQUE_SUB);
    // And it never saw a different sub for this send.
    const nonNull = observedGateSubs.filter((s) => s != null);
    expect(nonNull.every((s) => s === UNIQUE_SUB)).toBe(true);

    try { ws.close(); } catch { /* noop */ }
    bridge.close();
    await delay(100);
  }, 20000);

  it("two operators bind their OWN distinct subs (per-connection identity, no cross-bind)", async () => {
    const SECRET = "integration-secret-two-op";
    const SUB_A = `opA-${process.pid}@example.com`;
    const SUB_B = `opB-${process.pid}@example.com`;

    fs.writeFileSync(configFile, JSON.stringify({
      auth: { secret: SECRET, requireBrowserAuth: true },
    }));
    const loaded = loadConfig();

    handle = await createTestServer({
      authConfig: loaded.auth,
      resolvedTrustedNetworks: loaded.resolvedTrustedNetworks,
    });
    const { httpPort, piPort } = handle;

    const bridge = new WebSocket(`ws://localhost:${piPort}`);
    await tryOpen(bridge);
    bridge.send(JSON.stringify({ type: "session_register", sessionId: "sTwo", cwd: "/tmp", source: "tui", name: "Two" }));
    bridge.send(JSON.stringify({ type: "replay_complete", sessionId: "sTwo" }));
    await delay(150);

    const tokenA = signToken({ sub: SUB_A, name: "A", username: "a", provider: "github" }, SECRET);
    const tokenB = signToken({ sub: SUB_B, name: "B", username: "b", provider: "github" }, SECRET);

    const wsA = new WebSocket(`ws://localhost:${httpPort}/ws`, { headers: { Cookie: `${COOKIE_NAME}=${tokenA}` } });
    expect(await tryOpen(wsA)).toBe(true);
    await delay(80);
    observedGateSubs.length = 0; // isolate the two sends below

    wsA.send(JSON.stringify({ type: "send_prompt", sessionId: "sTwo", text: "from A" }));
    await delay(200);
    const afterA = [...observedGateSubs];

    const wsB = new WebSocket(`ws://localhost:${httpPort}/ws`, { headers: { Cookie: `${COOKIE_NAME}=${tokenB}` } });
    expect(await tryOpen(wsB)).toBe(true);
    await delay(80);
    observedGateSubs.length = 0;

    wsB.send(JSON.stringify({ type: "send_prompt", sessionId: "sTwo", text: "from B" }));
    await delay(200);
    const afterB = [...observedGateSubs];

    // A's send seam saw ONLY A's sub; B's saw ONLY B's — no cross-bind.
    expect(afterA.filter((s) => s != null)).toEqual([SUB_A]);
    expect(afterB.filter((s) => s != null)).toEqual([SUB_B]);

    // H-T1 (Build 1b §7): the A-AFTER-B case. The binding test above sends
    // A-before-B then B, never A again after B connected — so a global
    // `lastPrincipal` regression (B's connect clobbering a shared slot) would
    // pass it. Send from A AGAIN, after B is connected, and assert A's seam
    // STILL sees A's sub — proving per-socket `Map<WS,principal>` binding, not a
    // last-writer-wins global. Red-arm: replace the browser-gateway per-socket
    // Map with a single module-level `lastPrincipal` → this sees SUB_B → fails.
    observedGateSubs.length = 0;
    wsA.send(JSON.stringify({ type: "send_prompt", sessionId: "sTwo", text: "from A again" }));
    await delay(200);
    const afterAAgain = [...observedGateSubs];
    expect(afterAAgain.filter((s) => s != null)).toEqual([SUB_A]);

    try { wsA.close(); } catch { /* noop */ }
    try { wsB.close(); } catch { /* noop */ }
    bridge.close();
    await delay(100);
  }, 20000);
});
