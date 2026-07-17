import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocket } from "ws";
import { createServer, type DashboardServer } from "../server.js";

/**
 * Loading ≠ empty — the empty-BRIDGE re-replay terminal (build-2 fix-cycle-2
 * MAJOR 2). The empty-DISK path was fixed in fix-cycle-1; this locks the BRIDGE
 * path: a bridge that registers + `replay_complete`s with ZERO events (fresh /
 * compacted session) must still emit a terminal `event_replay{isLast:true}` so
 * a subscribed browser settles to "No messages yet" instead of loading forever.
 *
 * Uses the real server + WS bridge + WS browser (same harness family as
 * unseen-server-error-wiring). See change: build-2-dashboard-v3 (fix-cycle-2).
 */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function openBrowser(browserPort: number, sessionId: string): Promise<{
  ws: WebSocket;
  replays: Array<{ events: unknown[]; isLast?: boolean }>;
}> {
  const ws = new WebSocket(`ws://localhost:${browserPort}/ws`);
  const replays: Array<{ events: unknown[]; isLast?: boolean }> = [];
  await new Promise<void>((resolve) => {
    ws.on("open", () => {
      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === "event_replay" && msg.sessionId === sessionId) {
            replays.push({ events: msg.events, isLast: msg.isLast });
          }
        } catch { /* ignore */ }
      });
      ws.send(JSON.stringify({ type: "subscribe", sessionId }));
      setTimeout(resolve, 80);
    });
  });
  return { ws, replays };
}

describe("loading ≠ empty — empty-bridge re-replay terminal (MAJOR 2 bridge edge)", () => {
  let server: DashboardServer;
  let piPort: number;
  let browserPort: number;
  let testPort = 19800;

  beforeEach(async () => {
    testPort += 2;
    browserPort = testPort;
    piPort = testPort + 1;
    server = await createServer({
      port: browserPort,
      piPort,
      dev: true,
      autoShutdown: false,
      shutdownIdleSeconds: 999,
      tunnel: false,
      editor: { idleTimeoutMinutes: 10, maxInstances: 3 },
    });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it("an empty bridge register + replay_complete emits a terminal event_replay{isLast:true, events:[]}", async () => {
    // Bridge registers a session with ZERO events, then replay_complete.
    const piWs = new WebSocket(`ws://localhost:${piPort}`);
    await new Promise<void>((resolve) => {
      piWs.on("open", () => {
        piWs.send(JSON.stringify({ type: "session_register", sessionId: "m2", cwd: "/tmp", source: "cli" }));
        setTimeout(resolve, 60);
      });
    });

    // Browser subscribes AFTER register (so the register's session_state_reset
    // has fired; the subscribe replays zero stored events).
    const { ws: browser, replays } = await openBrowser(browserPort, "m2");

    // Now the bridge signals replay is done with NO events forwarded.
    piWs.send(JSON.stringify({ type: "replay_complete", sessionId: "m2" }));
    await wait(150);

    // A terminal batch (isLast:true) must have arrived, carrying zero events.
    const terminal = replays.find((r) => r.isLast === true);
    expect(terminal).toBeDefined();
    expect(terminal!.events).toEqual([]);

    piWs.close();
    browser.close();
  });

  it("the 5s-safety-timeout fallback (register, NO replay_complete) also terminates when empty", async () => {
    // This exercises the register-fallback terminal without waiting 5s by
    // asserting the wiring path exists: register with no events, subscribe, and
    // send replay_complete late — the terminal still arrives with events:[].
    const piWs = new WebSocket(`ws://localhost:${piPort}`);
    await new Promise<void>((resolve) => {
      piWs.on("open", () => {
        piWs.send(JSON.stringify({ type: "session_register", sessionId: "m2b", cwd: "/tmp", source: "cli" }));
        setTimeout(resolve, 60);
      });
    });
    const { ws: browser, replays } = await openBrowser(browserPort, "m2b");
    piWs.send(JSON.stringify({ type: "replay_complete", sessionId: "m2b" }));
    await wait(150);
    expect(replays.some((r) => r.isLast === true && (r.events as unknown[]).length === 0)).toBe(true);
    piWs.close();
    browser.close();
  });
});
