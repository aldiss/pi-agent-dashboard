import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocket } from "ws";
import { createServer, type DashboardServer } from "../server.js";

/**
 * Loading ≠ empty — the empty-BRIDGE re-replay terminal (build-2 fix-cycle-2
 * MAJOR 2), HARDENED in fix-cycle-3 to PIN the fix.
 *
 * The fix lives in `event-wiring.ts`: on an empty bridge `replay_complete` (and
 * the 5s register-fallback), the server must emit a terminal
 * `event_replay { isLast:true, events:[] }` AFTER the `session_state_reset`, so
 * a subscribed browser settles to "No messages yet" instead of loading forever.
 *
 * Why the r2 tests were false-positive-prone: the SUBSCRIBE path itself sends a
 * terminal `event_replay{isLast:true}` for a session with no stored events, so
 * "some isLast exists" passed even if the event-wiring post-reset terminal
 * regressed. These hardened tests subscribe BEFORE register and assert the
 * ORDER — a terminal MUST arrive AFTER the `session_state_reset` — so dropping
 * the post-reset terminal (either the replay_complete arm OR the 5s fallback
 * arm) makes the test RED.
 *
 * See change: build-2-dashboard-v3 (fix-cycle-3 test-hardening).
 */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Frame { type: string; events?: unknown[]; isLast?: boolean }

/**
 * Open a browser, subscribe to `sessionId`, and record `event_replay` +
 * `session_state_reset` frames IN ARRIVAL ORDER so tests can assert the
 * terminal-after-reset transition.
 */
async function openBrowserOrdered(browserPort: number, sessionId: string): Promise<{
  ws: WebSocket;
  frames: Frame[];
}> {
  const ws = new WebSocket(`ws://localhost:${browserPort}/ws`);
  const frames: Frame[] = [];
  await new Promise<void>((resolve) => {
    ws.on("open", () => {
      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.sessionId !== sessionId) return;
          if (msg.type === "event_replay") frames.push({ type: msg.type, events: msg.events, isLast: msg.isLast });
          else if (msg.type === "session_state_reset") frames.push({ type: msg.type });
        } catch { /* ignore */ }
      });
      ws.send(JSON.stringify({ type: "subscribe", sessionId }));
      setTimeout(resolve, 80);
    });
  });
  return { ws, frames };
}

/** Index of the first empty terminal `event_replay{isLast:true, events:[]}`. */
function emptyTerminalIndexAfter(frames: Frame[], afterIdx: number): number {
  for (let i = afterIdx + 1; i < frames.length; i++) {
    const f = frames[i];
    if (f.type === "event_replay" && f.isLast === true && Array.isArray(f.events) && f.events.length === 0) return i;
  }
  return -1;
}

describe("loading ≠ empty — empty-bridge terminal-after-reset transition (MAJOR 2, pinned)", () => {
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

  it("emits the terminal isLast:true AFTER the session_state_reset (replay_complete arm)", async () => {
    // 1) Browser subscribes BEFORE register. The subscribe path emits its own
    //    terminal for an unknown session — captured at an EARLY index, before
    //    any reset. This is exactly what masked the r2 test.
    const { ws: browser, frames } = await openBrowserOrdered(browserPort, "m2");
    await wait(40);

    // 2) Bridge registers (no eventCount) → server wipes + broadcasts
    //    session_state_reset to the subscribed browser.
    const piWs = new WebSocket(`ws://localhost:${piPort}`);
    await new Promise<void>((resolve) => {
      piWs.on("open", () => {
        piWs.send(JSON.stringify({ type: "session_register", sessionId: "m2", cwd: "/tmp", source: "cli" }));
        setTimeout(resolve, 80);
      });
    });

    // 3) Bridge signals replay done with ZERO events forwarded.
    piWs.send(JSON.stringify({ type: "replay_complete", sessionId: "m2" }));
    await wait(150);

    // The reset MUST have arrived...
    const resetIdx = frames.findIndex((f) => f.type === "session_state_reset");
    expect(resetIdx, `expected a session_state_reset frame; got ${JSON.stringify(frames)}`).toBeGreaterThanOrEqual(0);

    // ...and a terminal empty event_replay MUST arrive AFTER it (the post-reset
    // terminal produced by the M2 fix). A regression that drops this terminal
    // leaves only the pre-register subscribe-terminal (before the reset) → RED.
    const terminalIdx = emptyTerminalIndexAfter(frames, resetIdx);
    expect(terminalIdx, `expected terminal isLast:true AFTER reset@${resetIdx}; frames=${JSON.stringify(frames)}`).toBeGreaterThan(resetIdx);

    piWs.close();
    browser.close();
  });

  it("the 5s no-completion fallback emits the terminal isLast:true AFTER the reset (fallback arm)", async () => {
    // Same transition, but replay_complete NEVER arrives — the real 5s
    // register-fallback timer in event-wiring must fire the terminal. This
    // exercises the ACTUAL production setTimeout(…, 5000), pinning the fallback
    // arm (the r2 test never drove this path).
    const { ws: browser, frames } = await openBrowserOrdered(browserPort, "m2b");
    await wait(40);

    const piWs = new WebSocket(`ws://localhost:${piPort}`);
    await new Promise<void>((resolve) => {
      piWs.on("open", () => {
        piWs.send(JSON.stringify({ type: "session_register", sessionId: "m2b", cwd: "/tmp", source: "cli" }));
        setTimeout(resolve, 80);
      });
    });

    // Deliberately DO NOT send replay_complete. Wait past the 5s safety timer.
    const resetIdx = frames.findIndex((f) => f.type === "session_state_reset");
    expect(resetIdx).toBeGreaterThanOrEqual(0);
    // No terminal yet (before the fallback fires).
    expect(emptyTerminalIndexAfter(frames, resetIdx)).toBe(-1);

    await wait(5400); // let the real 5s register-fallback timer fire

    const terminalIdx = emptyTerminalIndexAfter(frames, resetIdx);
    expect(terminalIdx, `expected 5s-fallback terminal AFTER reset@${resetIdx}; frames=${JSON.stringify(frames)}`).toBeGreaterThan(resetIdx);

    piWs.close();
    browser.close();
  }, 12_000);
});
