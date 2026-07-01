/**
 * W1b amend — heartbeat-timeout TIMER-PATH → consumer wiring (Alice dl-3712 +
 * Bert dl-3714).
 *
 * The original W1b threaded `bridgeDisconnectReason` through `onDisconnect`, but
 * `onDisconnect` fired ONLY from `ws.on("close")`. The ACTUAL heartbeat-timeout
 * drop — Mechanism-A, the dl-3598 disaster that took the crew dashboard-blind —
 * unregisters from TIMER paths that called `sessionManager.unregister` directly,
 * recording NO reason. This suite proves the amend:
 *
 *   (1) TIMER-PATH WIRING (not just the classifier): induce a real heartbeat
 *       timeout against a live gateway → the row records reason
 *       `"heartbeat-timeout"`, and it is READABLE AFTER the timer-driven
 *       unregister (persistence — the row is kept-not-deleted).
 *   (2) STRUCTURAL INVARIANT: both disconnect origins (ws-close AND the timer/
 *       ping/explicit sites) route through the ONE shared `stampDisconnect`
 *       helper — `classifyBridgeDisconnect` + `onDisconnect` each appear exactly
 *       once (inside the helper), and ≥6 sites call the helper. A future drop-
 *       site can't silently skip instrumentation without deliberately bypassing.
 *
 * See change: bridge-disconnect-reason-timer-paths.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";
import { createPiGateway } from "../pi-gateway.js";
import { createMemorySessionManager } from "../memory-session-manager.js";
import type { DashboardSession, BridgeDisconnectReason } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import { WebSocket } from "ws";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    ws.on("open", () => resolve());
    ws.on("error", reject);
    setTimeout(() => reject(new Error("open timeout")), 3000);
  });
}

/** The real event-wiring consumer body (persist reason + timestamp on the row). */
function wireRealConsumer(
  gateway: ReturnType<typeof createPiGateway>,
  sessionManager: ReturnType<typeof createMemorySessionManager>,
) {
  gateway.onDisconnect = (sessionId, reason) => {
    if (!sessionManager.get(sessionId)) return;
    const updates: Partial<DashboardSession> = {
      bridgeDisconnectReason: reason,
      bridgeDisconnectAt: Date.now(),
    };
    sessionManager.update(sessionId, updates);
  };
}

let portCounter = 19640;

describe("W1b amend — heartbeat-timeout timer path stamps the reason", () => {
  let gateway: ReturnType<typeof createPiGateway>;
  afterEach(() => gateway?.stop());

  it("records reason='heartbeat-timeout' via the TIMER path, READABLE after the timer-driven unregister", async () => {
    const sessionManager = createMemorySessionManager();
    // Short heartbeat + disabled ping loop so the timer path (not the ping-
    // timeout site) drives the drop deterministically within the test window.
    gateway = createPiGateway(sessionManager, { heartbeatTimeout: 120, pingInterval: 0 });
    wireRealConsumer(gateway, sessionManager);
    const port = portCounter++;
    gateway.start(port);

    const ws = new WebSocket(`ws://localhost:${port}`);
    await waitForOpen(ws);
    ws.send(JSON.stringify({ type: "session_register", sessionId: "hb-timer", cwd: "/tmp", source: "tui", pid: 999999 }));
    await delay(60);
    expect(sessionManager.get("hb-timer")?.status).toBe("active");

    // Abrupt terminate: the server-side heartbeat timer survives the close and
    // fires later; because the socket is non-OPEN it proceeds grace→unregister,
    // stamping heartbeat-timeout via the shared helper. (The ws-close origin may
    // stamp an intermediate reason; the timer path is authoritative and last.)
    ws.terminate();

    // Wait past 2× heartbeatTimeout (grace → reconnect-grace-expired unregister).
    await delay(500);

    const row = sessionManager.get("hb-timer");
    // Persistence: the row survives the unregister (kept-not-deleted) and the
    // reason is READABLE after it (Bert's persist-through-unregister requirement).
    expect(row).toBeDefined();
    expect(row?.status).toBe("ended");
    expect(row?.bridgeDisconnectReason).toBe("heartbeat-timeout");
    expect(typeof row?.bridgeDisconnectAt).toBe("number");
  }, 10000);

  it("reason is non-blank after a timer drop (fail-loud: never silently unrecorded)", async () => {
    const sessionManager = createMemorySessionManager();
    gateway = createPiGateway(sessionManager, { heartbeatTimeout: 120, pingInterval: 0 });
    wireRealConsumer(gateway, sessionManager);
    const port = portCounter++;
    gateway.start(port);

    const ws = new WebSocket(`ws://localhost:${port}`);
    await waitForOpen(ws);
    ws.send(JSON.stringify({ type: "session_register", sessionId: "hb-timer-2", cwd: "/tmp", source: "tui" }));
    await delay(60);
    ws.terminate();
    await delay(500);

    const reason: BridgeDisconnectReason | undefined = sessionManager.get("hb-timer-2")?.bridgeDisconnectReason;
    // The Mechanism-A drop MUST record a reason — never blank (Gap #4).
    expect(reason).toBeDefined();
    expect(reason).not.toBe("");
    expect(reason).toBe("heartbeat-timeout");
  }, 10000);

  // ── NEGATIVE (Bert two-sided invariant): benign GC must NOT stamp ──
  // The reload-placeholder cleanup (pi-gateway session_register, the "old
  // placeholder" branch) unregisters a placeholder/ghost row when the SAME
  // bridge re-registers under its real sessionId. Nothing "dropped" — stamping
  // a disconnect reason there would be a FALSE-POSITIVE (phantom reason on a
  // non-disconnect). Assert the discarded placeholder carries NO reason.
  it("benign reload-placeholder GC does NOT stamp a disconnect reason (no false-positive)", async () => {
    const sessionManager = createMemorySessionManager();
    gateway = createPiGateway(sessionManager, { heartbeatTimeout: 5000, pingInterval: 0 });
    // Track EVERY onDisconnect fire so we can assert the placeholder id never fired.
    const fired: Array<{ id: string; reason: BridgeDisconnectReason }> = [];
    gateway.onDisconnect = (id, reason) => {
      fired.push({ id, reason });
      if (sessionManager.get(id)) {
        sessionManager.update(id, { bridgeDisconnectReason: reason, bridgeDisconnectAt: Date.now() });
      }
    };
    const port = portCounter++;
    gateway.start(port);

    const ws = new WebSocket(`ws://localhost:${port}`);
    await waitForOpen(ws);
    // First message carries a placeholder sessionId (auto-created, source
    // "unknown", no sessionFile) — this is the ghost the reload-GC retires.
    ws.send(JSON.stringify({ type: "session_heartbeat", sessionId: "ghost-placeholder" }));
    await delay(80);
    expect(sessionManager.get("ghost-placeholder")?.source).toBe("unknown");

    // Now the SAME ws registers under its REAL sessionId → triggers the 388
    // placeholder-GC branch (currentSessionId !== msg.sessionId, old row is a
    // source:"unknown" placeholder) → unregister WITHOUT stamping.
    ws.send(JSON.stringify({ type: "session_register", sessionId: "real-session", cwd: "/tmp", source: "tui", sessionFile: "/tmp/real.jsonl" }));
    await delay(120);

    const ghost = sessionManager.get("ghost-placeholder");
    expect(ghost?.status).toBe("ended"); // it WAS unregistered (GC'd)
    // …but NO disconnect reason was stamped on it (benign GC, not a disconnect).
    expect(ghost?.bridgeDisconnectReason).toBeUndefined();
    // And onDisconnect never fired for the placeholder id.
    expect(fired.some((f) => f.id === "ghost-placeholder")).toBe(false);

    ws.close();
  }, 10000);
});

// ── (2) STRUCTURAL INVARIANT: both origins route through ONE shared helper ──
describe("W1b amend — structural symmetry: all disconnect origins use stampDisconnect", () => {
  it("classifyBridgeDisconnect + onDisconnect fire ONLY inside the shared helper; ≥6 sites call it", async () => {
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const gatewaySrc = path.resolve(here, "..", "pi-gateway.ts");
    const src = await fs.readFile(gatewaySrc, "utf-8");

    // Count actual CALL sites (exclude imports, type decls, comments).
    const codeLines = src
      .split(/\r?\n/)
      .filter((l) => {
        const t = l.trim();
        return t.length > 0 && !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/**");
      });

    const classifyCalls = codeLines.filter((l) => /\bclassifyBridgeDisconnect\(/.test(l)).length;
    const onDisconnectCalls = codeLines.filter((l) => /\bonDisconnect\?\.\(/.test(l)).length;
    const stampDefs = codeLines.filter((l) => /function stampDisconnect\(/.test(l)).length;
    // Call sites only: the negative lookbehind already excludes the `function
    // stampDisconnect(` definition line, so this count is pure call-sites.
    const stampCalls = codeLines.filter((l) => /(?<!function )\bstampDisconnect\(/.test(l)).length;

    // The classifier + the onDisconnect fire are each funnelled to exactly ONE
    // place — inside stampDisconnect — so instrumentation can't diverge.
    expect(classifyCalls, "classifyBridgeDisconnect must be called exactly once (inside stampDisconnect)").toBe(1);
    expect(onDisconnectCalls, "onDisconnect must be fired exactly once (inside stampDisconnect)").toBe(1);
    expect(stampDefs, "exactly one stampDisconnect definition").toBe(1);
    // Both origins + all direct-unregister drop-sites call the helper: ws-close,
    // 3 timer paths, ping-timeout, explicit session_unregister = 6.
    expect(stampCalls, "≥6 disconnect origins must route through stampDisconnect").toBeGreaterThanOrEqual(6);
  });
});
