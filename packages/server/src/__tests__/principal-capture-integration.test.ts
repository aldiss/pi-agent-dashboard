/**
 * Build 0 v2 — flag-activation-surface integration tests (gate-pushback-1).
 *
 * These exercise the REAL config-load → server → `/ws` upgrade → gateway →
 * handler chain that the unit tests (`principal-capture.test.ts`) could not:
 *
 *  BLOCKER — a `{"auth":{"requireBrowserAuth":true}}` config (no providers /
 *    bypass / secret) loaded through `loadConfig()` (== through `parseAuthConfig`)
 *    must make a no-cookie `/ws` upgrade REFUSED, not loopback-OPEN. This is the
 *    parser-drop trap: a direct `validateWsUpgrade` call hid it because it never
 *    goes through the parser.
 *
 *  MINOR — with the gate ON + a valid `pi_dash_token`, the decoded principal
 *    from the upgrade must actually reach `BrowserHandlerContext.principal` on a
 *    real socket (gate→request→Map→ctx binding chain), and a no-cookie sibling
 *    must be refused through the real upgrade path.
 *
 * Both are red-arm-proven (see the build report). HOME is set per-test to a
 * fresh tmp dir so `loadConfig()` reads a controlled `config.json`.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { WebSocket } from "ws";
import { loadConfig } from "@blackbelt-technology/pi-dashboard-shared/config.js";
import { signToken, COOKIE_NAME } from "../auth.js";
import { createTestServer, type TestServerHandle } from "../test-support/test-server.js";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Resolve true if the socket OPENs, false if the handshake is refused. */
function tryOpen(ws: WebSocket, ms = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: boolean) => { if (!settled) { settled = true; resolve(v); } };
    if (ws.readyState === WebSocket.OPEN) return done(true);
    ws.on("open", () => done(true));
    ws.on("error", () => done(false));            // ECONNREFUSED / handshake 401
    ws.on("unexpected-response", () => done(false)); // HTTP 401 on upgrade
    setTimeout(() => done(ws.readyState === WebSocket.OPEN), ms);
  });
}

describe("Build 0 v2 — flag-activation surface (config-load → /ws)", () => {
  let testDir: string;
  let configFile: string;
  let origHome: string;
  let handle: TestServerHandle | undefined;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "b0-flagsurface-"));
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

  // ── BLOCKER ─────────────────────────────────────────────────────────────
  it("BLOCKER: requireBrowserAuth:true (no providers/secret) loaded via loadConfig() REFUSES a no-cookie /ws", async () => {
    // The exact drop-trap config: nothing auth-relevant EXCEPT the flag.
    fs.writeFileSync(configFile, JSON.stringify({ auth: { requireBrowserAuth: true } }));

    // Exercise the FULL parse chain — this is what hid the bug from the direct
    // validateWsUpgrade unit test.
    const loaded = loadConfig();
    // Sanity: the parser must NOT have dropped the flag to undefined.
    expect(loaded.auth?.requireBrowserAuth).toBe(true);

    handle = await createTestServer({
      authConfig: loaded.auth,
      resolvedTrustedNetworks: loaded.resolvedTrustedNetworks,
    });

    // A loopback browser with NO cookie must be REFUSED (the gate does not honor
    // the loopback bypass in multi-op mode). If parseAuthConfig had dropped the
    // flag, authConfig would be undefined and this socket would OPEN.
    const ws = new WebSocket(`ws://localhost:${handle.httpPort}/ws`);
    const opened = await tryOpen(ws);
    try { ws.close(); } catch { /* noop */ }
    expect(opened).toBe(false);
  }, 15000);

  it("control: with NO auth block, a loopback /ws OPENs (single-op byte-unchanged)", async () => {
    fs.writeFileSync(configFile, JSON.stringify({ port: 8000 }));
    const loaded = loadConfig();
    expect(loaded.auth).toBeUndefined();

    handle = await createTestServer({
      authConfig: loaded.auth,
      resolvedTrustedNetworks: loaded.resolvedTrustedNetworks,
    });

    const ws = new WebSocket(`ws://localhost:${handle.httpPort}/ws`);
    const opened = await tryOpen(ws);
    try { ws.close(); } catch { /* noop */ }
    expect(opened).toBe(true);
  }, 15000);

  // ── MINOR: gate→request→Map→ctx binding chain ────────────────────────────
  it("MINOR: valid pi_dash_token binds the decoded principal all the way to the send handler", async () => {
    const SECRET = "integration-secret-for-binding-chain";
    fs.writeFileSync(configFile, JSON.stringify({
      auth: { secret: SECRET, requireBrowserAuth: true },
    }));
    const loaded = loadConfig();
    expect(loaded.auth?.requireBrowserAuth).toBe(true);

    handle = await createTestServer({
      authConfig: loaded.auth,
      resolvedTrustedNetworks: loaded.resolvedTrustedNetworks,
    });
    const { httpPort, piPort, server } = handle;

    // Bridge registers a live session so a send_prompt has somewhere to go.
    const bridge = new WebSocket(`ws://localhost:${piPort}`);
    await tryOpen(bridge);
    bridge.send(JSON.stringify({ type: "session_register", sessionId: "sBind", cwd: "/tmp", source: "tui", name: "Bind" }));
    bridge.send(JSON.stringify({ type: "replay_complete", sessionId: "sBind" }));
    await delay(150);

    // Capture what the bridge receives so we can assert the send reached pi.
    const bridgeInbox: any[] = [];
    bridge.on("message", (raw) => { try { bridgeInbox.push(JSON.parse(raw.toString())); } catch { /* noop */ } });

    // Browser connects WITH a valid cookie → the upgrade must bind the principal.
    const token = signToken({ sub: "op1@example.com", name: "Op One", username: "op1", provider: "github" }, SECRET);
    const ws = new WebSocket(`ws://localhost:${httpPort}/ws`, {
      headers: { Cookie: `${COOKIE_NAME}=${token}` },
    });
    const opened = await tryOpen(ws);
    expect(opened).toBe(true);
    await delay(100); // drain snapshot

    ws.send(JSON.stringify({ type: "send_prompt", sessionId: "sBind", text: "hello from op1" }));
    await delay(250);

    // The send passed the send-seam gate (principal was bound) and reached pi.
    const forwarded = bridgeInbox.find((m) => m.type === "send_prompt" && m.sessionId === "sBind");
    expect(forwarded).toBeDefined();
    expect(forwarded.text).toBe("hello from op1");
    // Surface A end-to-end anti-spoof: the browser sent NO author in the body,
    // yet the forwarded send carries the SERVER-DERIVED author from the bound
    // cookie principal (op1) — proving the author is derived server-side from
    // the connection, never from the message body. A forged top-level
    // `principal` field never rides through (field-by-field reconstruct).
    expect(forwarded.author).toEqual({ sub: "op1@example.com", display: "Op One" });
    expect(forwarded).not.toHaveProperty("principal");

    // Sibling: a NO-cookie /ws against the same server is refused.
    const wsNoCookie = new WebSocket(`ws://localhost:${httpPort}/ws`);
    const openedNoCookie = await tryOpen(wsNoCookie);
    expect(openedNoCookie).toBe(false);

    try { ws.close(); } catch { /* noop */ }
    try { wsNoCookie.close(); } catch { /* noop */ }
    bridge.close();
    await delay(100);
    void server;
  }, 20000);

  // ── MAJOR (desync): the two gates never diverge on a runtime flip ─────────
  it("MAJOR: flipping requireBrowserAuth OFF via /api/config is restart-required — the live upgrade gate stays frozen-ON (no desync)", async () => {
    const SECRET = "integration-secret-desync";
    // Start with the gate ON.
    fs.writeFileSync(configFile, JSON.stringify({
      auth: { secret: SECRET, requireBrowserAuth: true },
    }));
    const loaded = loadConfig();
    expect(loaded.auth?.requireBrowserAuth).toBe(true);

    handle = await createTestServer({
      authConfig: loaded.auth,
      resolvedTrustedNetworks: loaded.resolvedTrustedNetworks,
    });
    const { httpPort } = handle;

    // Baseline: a no-cookie /ws is refused (gate ON).
    const before = new WebSocket(`ws://localhost:${httpPort}/ws`);
    expect(await tryOpen(before)).toBe(false);
    try { before.close(); } catch { /* noop */ }

    // Flip the flag OFF through the real reload path (PUT /api/config →
    // writeConfigPartial + system-routes reload that reassigns config.authConfig).
    const res = await fetch(`http://localhost:${httpPort}/api/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ auth: { requireBrowserAuth: false } }),
    });
    const body = await res.json();
    expect(body.success).toBe(true);
    // The flip is restart-required — it is NOT applied live.
    expect(body.restartRequired).toBe(true);
    // On-disk it flipped (takes effect next start).
    const written = JSON.parse(fs.readFileSync(configFile, "utf-8"));
    expect(written.auth.requireBrowserAuth).toBe(false);

    await delay(100);

    // THE DESYNC ASSERTION: the live upgrade gate must STILL refuse a no-cookie
    // /ws — it reads the startup-frozen boolean (ON), agreeing with the browser
    // gateway's still-frozen-ON send-seam gate. If the upgrade gate read the
    // mutated config.authConfig, this socket would now OPEN (gate divergence).
    const after = new WebSocket(`ws://localhost:${httpPort}/ws`);
    const openedAfter = await tryOpen(after);
    try { after.close(); } catch { /* noop */ }
    expect(openedAfter).toBe(false);
  }, 20000);
});
