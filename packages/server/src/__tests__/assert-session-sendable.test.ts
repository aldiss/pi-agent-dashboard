/**
 * assert-session-sendable — WI-1 probe primitive, own-hand REAL round-trip test.
 *
 * No mock. A real DashboardServer (createTestServer) + a real extension
 * WebSocket on the pi-gateway. The probe hits the canonical send path over real
 * HTTP and we assert the 2xx-vs-502 classification against the live gateway:
 *   - a registered session (OPEN :9999 ws)        → {sendable:true,  status:200}
 *   - a never-registered / stuck session (no ws)  → {sendable:false, status:502, reason:"no bridge connection…"}
 *   - an unknown session id                       → {sendable:false, status:404}
 *   - a dead server (round-trip cannot complete)  → {sendable:false, reason:…}
 *
 * See change: handover-reliability-wi1 (PART 2).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createTestServer, type TestServerHandle } from "../test-support/test-server.js";
import { assertSessionSendable } from "../assert-session-sendable.js";

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    ws.on("open", () => resolve());
    ws.on("error", reject);
    setTimeout(() => reject(new Error("open timeout")), 3000);
  });
}
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

let handle: TestServerHandle;
let baseUrl: string;
let piPort: number;
let bridge: WebSocket;

describe("assertSessionSendable — real round-trip (WI-1 probe)", () => {
  beforeAll(async () => {
    handle = await createTestServer();
    baseUrl = `http://localhost:${handle.httpPort}`;
    piPort = handle.piPort;

    // A real extension bridge registers ONE session → it holds an OPEN :9999 ws.
    bridge = new WebSocket(`ws://localhost:${piPort}`);
    await waitForOpen(bridge);
    bridge.send(JSON.stringify({
      type: "session_register", sessionId: "sendable-1", cwd: "/tmp", source: "tui", name: "Live",
    }));
    bridge.send(JSON.stringify({ type: "replay_complete", sessionId: "sendable-1" }));
    await delay(200); // let the gateway register the connection

    // A second session is known to the manager but its bridge is GONE (stuck) —
    // register then drop the socket, so the manager row survives but no ws does.
    const stuckBridge = new WebSocket(`ws://localhost:${piPort}`);
    await waitForOpen(stuckBridge);
    stuckBridge.send(JSON.stringify({
      type: "session_register", sessionId: "stuck-1", cwd: "/tmp", source: "tui", name: "Stuck",
    }));
    await delay(150);
    stuckBridge.close(); // drop the bridge → gateway no longer has an OPEN ws for stuck-1
    await delay(250);
  }, 20000);

  afterAll(async () => {
    try { bridge?.close(); } catch { /* ignore */ }
    if (handle) await handle.stop();
  });

  it("a registered session with an OPEN :9999 bridge → {sendable:true, status:200}", async () => {
    const result = await assertSessionSendable(baseUrl, "sendable-1");
    expect(result.sendable).toBe(true);
    expect(result.status).toBe(200);
    expect(result.reason).toBeUndefined();
  });

  it("a known session whose bridge has DROPPED → {sendable:false, status:502} (no bridge connection)", async () => {
    const result = await assertSessionSendable(baseUrl, "stuck-1");
    expect(result.sendable).toBe(false);
    expect(result.status).toBe(502);
    expect(result.reason).toMatch(/no bridge connection/i);
  });

  it("an unknown session id → {sendable:false, status:404}", async () => {
    const result = await assertSessionSendable(baseUrl, "does-not-exist");
    expect(result.sendable).toBe(false);
    expect(result.status).toBe(404);
  });

  it("the sentinel probe text is what gets sent (default), and a custom text is honored", async () => {
    // Both round-trips succeed on the live session; this asserts the option
    // plumbs through without throwing and still classifies sendable.
    const def = await assertSessionSendable(baseUrl, "sendable-1");
    expect(def.sendable).toBe(true);
    const custom = await assertSessionSendable(baseUrl, "sendable-1", { text: "custom-probe" });
    expect(custom.sendable).toBe(true);
  });

  it("an unreachable server (round-trip cannot complete) → {sendable:false, reason}", async () => {
    // Point at a closed port — connection refused ⇒ not sendable, never throws.
    const result = await assertSessionSendable("http://127.0.0.1:1", "sendable-1", { timeoutMs: 1500 });
    expect(result.sendable).toBe(false);
    expect(result.reason).toBeTruthy();
    expect(result.status).toBeUndefined();
  }, 10000);
});
