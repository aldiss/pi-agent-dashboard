/**
 * pi-gateway fail-loud surface (Stage-2 (b)) — own-hand verification.
 *
 * Proves the P0 surface the server/supervisor observes:
 *   - a successful bind → status() === "listening" (gated on the real event).
 *   - an OCCUPIED port → the ASYNC EADDRINUSE is surfaced via onListenError +
 *     status() === "listen-failed" (previously: uncaughtException → suppressed →
 *     silent zombie). THE fail-loud fix.
 *   - a throwing session_register → onRegisterError fires (de-blanket): the
 *     failure is SURFACED, not swallowed by the old blanket `catch {}` that left
 *     the socket ESTABLISHED with no row (the wedge signature).
 */
import { describe, it, expect } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
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

describe("pi-gateway fail-loud surface", () => {
  it("status() === 'listening' after a successful bind on a free port", async () => {
    const gw = createPiGateway(makeSessionManager());
    gw.start(0); // ephemeral free port
    await wait(60);
    expect(gw.status()).toBe("listening");
    expect(gw.address()).toBeGreaterThan(0);
    gw.stop();
  });

  it("THE FIX — occupied port → onListenError fires + status() === 'listen-failed'", async () => {
    // Occupy an ephemeral port with a plain WS server.
    const blocker = new WebSocketServer({ port: 0 });
    await new Promise((r) => blocker.on("listening", r));
    const busyPort = (blocker.address() as { port: number }).port;

    const gw = createPiGateway(makeSessionManager());
    let listenErr: Error | undefined;
    gw.onListenError = (err) => {
      listenErr = err;
    };
    gw.start(busyPort); // async EADDRINUSE — a try/catch around the ctor cannot catch it
    await wait(120);

    expect(listenErr).toBeDefined(); // surfaced, NOT an uncaught+suppressed zombie
    expect(String(listenErr?.message)).toMatch(/EADDRINUSE|address already in use/i);
    expect(gw.status()).toBe("listen-failed");

    gw.stop();
    blocker.close();
  });

  it("de-blanket — a throwing session_register is SURFACED via onRegisterError", async () => {
    const gw = createPiGateway(
      makeSessionManager({
        register: () => {
          throw new Error("register boom");
        },
      }),
    );
    let reg: { sid: string | null; err: Error } | undefined;
    gw.onRegisterError = (sid, err) => {
      reg = { sid, err };
    };
    gw.start(0);
    await wait(40);
    const port = gw.address()!;

    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((r) => client.on("open", r));
    client.send(JSON.stringify({ type: "session_register", sessionId: "s1", cwd: "/p", source: "test" }));
    await wait(100);

    expect(reg).toBeDefined(); // the register throw did NOT vanish into a silent catch{}
    expect(reg?.err.message).toContain("register boom");

    client.close();
    gw.stop();
  });
});
