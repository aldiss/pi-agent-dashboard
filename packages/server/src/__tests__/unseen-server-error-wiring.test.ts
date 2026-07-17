import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocket } from "ws";
import { createServer, type DashboardServer } from "../server.js";

/**
 * End-to-end wiring test for `session.unseenServerError` (build-2 P0 fix #1 + #2).
 *
 * The whole point: an UNVISITED errored session must rank into needs-you
 * fleet-wide. These tests use the REAL bridge-forwarded payload shape — the pi
 * event's `messages[]` with a terminal `stopReason: "error"` + `errorMessage`,
 * forwarded UNCHANGED as `event.data` — NOT the invented `{ error }` fixture.
 *
 * The error arm is asserted DIRECTLY (via `session.unseenServerError`), never
 * through `unread` — the streaming→idle unread trigger fires on ANY finished
 * turn, so a passing `unread` assertion would mask a broken error arm.
 *
 * See change: build-2-dashboard-v3.
 */

async function registerSession(
  ws: WebSocket,
  sessionId: string,
  opts: { replayComplete?: boolean; sessionFile?: string } = {},
): Promise<void> {
  await new Promise<void>((resolve) => {
    ws.on("open", () => {
      ws.send(JSON.stringify({
        type: "session_register",
        sessionId,
        cwd: "/tmp",
        source: "cli",
        ...(opts.sessionFile ? { sessionFile: opts.sessionFile } : {}),
      }));
      if (opts.replayComplete !== false) {
        ws.send(JSON.stringify({ type: "replay_complete", sessionId }));
      }
      setTimeout(resolve, 60);
    });
  });
}

/** The REAL bridge-forwarded errored-turn payload (terminal message shape). */
function erroredAgentEnd(errorMessage = "rate limit exceeded"): Record<string, unknown> {
  return {
    messages: [
      { role: "user", content: "do the thing" },
      { role: "assistant", stopReason: "error", errorMessage },
    ],
  };
}

function sendEvent(
  ws: WebSocket,
  sessionId: string,
  eventType: string,
  data: Record<string, unknown> = {},
): void {
  ws.send(JSON.stringify({
    type: "event_forward",
    sessionId,
    event: { eventType, timestamp: Date.now(), data },
  }));
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("unseenServerError — server wiring", () => {
  let server: DashboardServer;
  let piPort: number;
  let browserPort: number;
  let testPort = 19600;

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

  it("errored agent_end while NOT viewed stamps unseenServerError (real bridge payload, error arm direct)", async () => {
    const piWs = new WebSocket(`ws://localhost:${piPort}`);
    await registerSession(piWs, "e1");

    sendEvent(piWs, "e1", "agent_start");
    await wait(50);
    // Canonical errored-turn shape — NOT { error: ... }
    sendEvent(piWs, "e1", "agent_end", erroredAgentEnd());
    await wait(120);

    // Assert the error arm DIRECTLY, not through unread.
    expect(server.sessionManager.get("e1")?.unseenServerError).toBe(true);

    piWs.close();
  });

  it("does NOT stamp unseenServerError for the invented { error } payload (canonical shape only)", async () => {
    const piWs = new WebSocket(`ws://localhost:${piPort}`);
    await registerSession(piWs, "e2");

    sendEvent(piWs, "e2", "agent_start");
    await wait(50);
    // Wrong shape — the legacy branch checked this; the canonical predicate must not.
    sendEvent(piWs, "e2", "agent_end", { error: "rate limit exceeded" });
    await wait(120);

    expect(server.sessionManager.get("e2")?.unseenServerError).toBeFalsy();

    piWs.close();
  });

  it("clean agent_end (no terminal error) does not stamp unseenServerError even though unread flips", async () => {
    const piWs = new WebSocket(`ws://localhost:${piPort}`);
    await registerSession(piWs, "e3");

    sendEvent(piWs, "e3", "agent_start");
    await wait(50);
    sendEvent(piWs, "e3", "agent_end", {
      messages: [{ role: "assistant", stopReason: "end_turn", content: "done" }],
    });
    await wait(120);

    const s = server.sessionManager.get("e3");
    // unread flips (turn finished) but the dedicated error arm stays clean —
    // proving the error arm is independent of the unread trigger.
    expect(s?.unread).toBe(true);
    expect(s?.unseenServerError).toBeFalsy();

    piWs.close();
  });

  it("replayed errored agent_end does NOT stamp unseenServerError", async () => {
    const ws = new WebSocket(`ws://localhost:${piPort}`);
    await new Promise<void>((resolve) => {
      ws.on("open", () => {
        ws.send(JSON.stringify({
          type: "session_register",
          sessionId: "e4",
          cwd: "/tmp",
          source: "cli",
        }));
        // Errored pair BEFORE replay_complete → replay window → must not stamp.
        sendEvent(ws, "e4", "agent_start");
        sendEvent(ws, "e4", "agent_end", erroredAgentEnd());
        setTimeout(resolve, 150);
      });
    });

    expect(server.sessionManager.get("e4")?.unseenServerError).toBeFalsy();
    ws.close();
  });

  it("a live recovery agent_start clears a previously-stamped unseenServerError", async () => {
    const piWs = new WebSocket(`ws://localhost:${piPort}`);
    await registerSession(piWs, "e5");

    sendEvent(piWs, "e5", "agent_start");
    await wait(40);
    sendEvent(piWs, "e5", "agent_end", erroredAgentEnd());
    await wait(120);
    expect(server.sessionManager.get("e5")?.unseenServerError).toBe(true);

    // Operator re-engages: a fresh live agent_start is a genuine recovery.
    sendEvent(piWs, "e5", "agent_start");
    await wait(80);
    expect(server.sessionManager.get("e5")?.unseenServerError).toBe(false);

    piWs.close();
  });

  it("session_view clears unseenServerError and broadcasts the clear", async () => {
    const piWs = new WebSocket(`ws://localhost:${piPort}`);
    await registerSession(piWs, "e6");

    const browser = new WebSocket(`ws://localhost:${browserPort}/ws`);
    const broadcasts: Array<Record<string, unknown>> = [];
    await new Promise<void>((resolve) => {
      browser.on("open", () => {
        browser.on("message", (raw) => {
          try {
            const msg = JSON.parse(raw.toString());
            if (msg.type === "session_updated" && msg.sessionId === "e6") broadcasts.push(msg);
          } catch { /* ignore */ }
        });
        browser.send(JSON.stringify({ type: "subscribe", sessionId: "e6" }));
        setTimeout(resolve, 80);
      });
    });

    sendEvent(piWs, "e6", "agent_start");
    await wait(40);
    sendEvent(piWs, "e6", "agent_end", erroredAgentEnd());
    await wait(120);
    expect(server.sessionManager.get("e6")?.unseenServerError).toBe(true);

    browser.send(JSON.stringify({ type: "session_view", sessionId: "e6" }));
    await wait(80);
    expect(server.sessionManager.get("e6")?.unseenServerError).toBe(false);

    const cleared = broadcasts.find(
      (b) => (b.updates as Record<string, unknown> | undefined)?.unseenServerError === false,
    );
    expect(cleared).toBeDefined();

    piWs.close();
    browser.close();
  });

  it("errored agent_end while a browser IS viewing does not stamp (viewer sees it live)", async () => {
    const piWs = new WebSocket(`ws://localhost:${piPort}`);
    await registerSession(piWs, "e7");

    const browser = new WebSocket(`ws://localhost:${browserPort}/ws`);
    await new Promise<void>((resolve) => {
      browser.on("open", () => {
        browser.send(JSON.stringify({ type: "subscribe", sessionId: "e7" }));
        browser.send(JSON.stringify({ type: "session_view", sessionId: "e7" }));
        setTimeout(resolve, 80);
      });
    });

    sendEvent(piWs, "e7", "agent_start");
    await wait(40);
    sendEvent(piWs, "e7", "agent_end", erroredAgentEnd());
    await wait(120);

    expect(server.sessionManager.get("e7")?.unseenServerError).toBeFalsy();

    piWs.close();
    browser.close();
  });

  it("unseenServerError survives bridge re-registration (register carry-forward, FATAL 1B)", async () => {
    const piWs = new WebSocket(`ws://localhost:${piPort}`);
    await registerSession(piWs, "e8");

    sendEvent(piWs, "e8", "agent_start");
    await wait(40);
    sendEvent(piWs, "e8", "agent_end", erroredAgentEnd());
    await wait(120);
    expect(server.sessionManager.get("e8")?.unseenServerError).toBe(true);

    // Simulate a bridge reconnect: a SECOND register() for the same id (no
    // live agent_start after it). The carry-forward whitelist must preserve
    // the flag — a bare re-registration must NOT erase error history.
    const piWs2 = new WebSocket(`ws://localhost:${piPort}`);
    await new Promise<void>((resolve) => {
      piWs2.on("open", () => {
        piWs2.send(JSON.stringify({
          type: "session_register",
          sessionId: "e8",
          cwd: "/tmp",
          source: "cli",
          registerReason: "reattach",
        }));
        // Replay historical events (errored pair) then complete — replay must
        // not clear the flag either.
        sendEvent(piWs2, "e8", "agent_start");
        sendEvent(piWs2, "e8", "agent_end", erroredAgentEnd());
        piWs2.send(JSON.stringify({ type: "replay_complete", sessionId: "e8" }));
        setTimeout(resolve, 150);
      });
    });

    expect(server.sessionManager.get("e8")?.unseenServerError).toBe(true);

    piWs.close();
    piWs2.close();
  });
});
