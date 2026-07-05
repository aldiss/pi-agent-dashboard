/**
 * pi-gateway terminate-on-displace (Stage-3 G5) — own-hand verification.
 *
 * A same-sessionId reconnect (~100× under a reload storm) used to OVERWRITE the
 * connections map entry WITHOUT closing the displaced socket → an orphan FD leak that
 * feeds the storm (validation §Design-delta 9). The fix:
 *   - setConnection() terminates a DIFFERENT prior socket before the set (latest wins,
 *     idempotent when it's the same socket re-registering);
 *   - the socket 'close' handler is CAS-guarded so a displaced socket's late close never
 *     disconnects the live session that now owns the sessionId.
 *
 * RED (pre-fix): "displaced socket is CLOSED" FAILS (the orphan stays OPEN) and "displaced
 * close does not disconnect the live session" FAILS (A's close fires onDisconnect for the
 * id B now owns). Proven by stashing pi-gateway.ts and re-running (own-hand).
 */
import { describe, it, expect, vi } from "vitest";
import { WebSocket } from "ws";
import { createPiGateway } from "../pi-gateway.js";

function makeSessionManager(overrides: Record<string, unknown> = {}) {
  const sessions = new Map<string, Record<string, unknown>>();
  return {
    register: (p: { id: string }) => {
      const s = { ...p, status: "active" };
      sessions.set(p.id, s);
      return s;
    },
    get: (id: string) => sessions.get(id),
    update: () => {},
    unregister: (id: string) => sessions.delete(id),
    listActive: () => [...sessions.values()],
    listAll: () => [...sessions.values()],
    ...overrides,
  } as never;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function connectAndRegister(port: number, sid: string): Promise<WebSocket> {
  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((r) => client.on("open", r));
  client.send(JSON.stringify({ type: "session_register", sessionId: sid, cwd: "/p", source: "test" }));
  await wait(60);
  return client;
}

describe("pi-gateway terminate-on-displace (G5)", () => {
  it("THE FIX — a same-sessionId reconnect closes the displaced socket (no orphan FD)", async () => {
    const gw = createPiGateway(makeSessionManager());
    gw.start(0);
    await wait(40);
    const port = gw.address()!;

    const a = await connectAndRegister(port, "S1");
    expect(gw.isSessionConnected("S1")).toBe(true);
    expect(gw.connectionCount()).toBe(1);

    const aClosed = new Promise<void>((r) => a.on("close", () => r()));
    const b = await connectAndRegister(port, "S1"); // displaces A
    await Promise.race([aClosed, wait(500)]);
    await wait(40);

    // The displaced socket A is CLOSED (terminated), not leaked as an orphan FD.
    expect(a.readyState).toBe(WebSocket.CLOSED);
    // Exactly one live socket owns S1 (the latest = B); no orphan map entry.
    expect(gw.connectionCount()).toBe(1);
    expect(gw.isSessionConnected("S1")).toBe(true);

    // sendToSession reaches B (the current owner), not A.
    const bGot = new Promise<string>((r) => b.on("message", (d) => r(d.toString())));
    const sent = gw.sendToSession("S1", { type: "__g5_probe__" } as never);
    expect(sent).toBe(true);
    const got = await Promise.race([bGot, wait(300).then(() => "__timeout__")]);
    expect(got).toContain("__g5_probe__");

    b.close();
    gw.stop();
  });

  it("CAS — the displaced socket's close does not disconnect the live session", async () => {
    const disconnects: string[] = [];
    const gw = createPiGateway(makeSessionManager());
    gw.onDisconnect = (sid) => disconnects.push(sid);
    gw.start(0);
    await wait(40);
    const port = gw.address()!;

    const a = await connectAndRegister(port, "S2");
    const b = await connectAndRegister(port, "S2"); // displaces A; A's close fires
    await wait(150);

    // A's close must NOT have fired onDisconnect for S2 — B owns it now.
    expect(disconnects).not.toContain("S2");
    expect(gw.isSessionConnected("S2")).toBe(true);
    void a;

    b.close();
    gw.stop();
  });

  it("behavior preserved — a normal (undisplaced) close still fires onDisconnect", async () => {
    const disconnects: string[] = [];
    const gw = createPiGateway(makeSessionManager());
    gw.onDisconnect = (sid) => disconnects.push(sid);
    gw.start(0);
    await wait(40);
    const port = gw.address()!;

    const a = await connectAndRegister(port, "S3");
    expect(gw.isSessionConnected("S3")).toBe(true);
    a.close();
    await wait(150);

    // The CAS guard must NOT suppress a genuine disconnect (this socket is the owner).
    expect(disconnects).toContain("S3");

    gw.stop();
  });

  it("idempotent — the same socket re-registering the same sessionId is not closed", async () => {
    const gw = createPiGateway(makeSessionManager());
    gw.start(0);
    await wait(40);
    const port = gw.address()!;

    const a = await connectAndRegister(port, "S4");
    // Re-register the SAME sid on the SAME socket — must be a no-op, not a self-terminate.
    a.send(JSON.stringify({ type: "session_register", sessionId: "S4", cwd: "/p", source: "test" }));
    await wait(80);

    expect(a.readyState).toBe(WebSocket.OPEN);
    expect(gw.isSessionConnected("S4")).toBe(true);
    expect(gw.connectionCount()).toBe(1);

    a.close();
    gw.stop();
  });
});
