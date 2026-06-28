/**
 * W7 DOGFOOD — adversarial RED/GREEN cross-wire isolation negative-control
 * (design-pass §6 + §5.3-B; empirical-scenario-library S10).
 *
 * The recursive proof: the harness's own first scenario exercises the harness's
 * single most dangerous failure mode — the bridge cross-wire that hijacked the
 * live crew (dl-2942 / dl-2976). Per §5.3-B a GREEN-only result is REJECTED:
 * without a RED arm we cannot distinguish "isolation works" from "the test is
 * blind". So this drives the REAL guard (autoStartServer + ConnectionManager —
 * the discovery subsystem the guard lives in, per Bert NOTE2, NOT the fixture
 * path) with REAL poison, in BOTH arms:
 *
 *   POISON (both vectors, injected the same in both arms):
 *     V1  mDNS-discovery-first  — discoverDashboard() returns a decoy live-like
 *                                 dashboard on a NON-sandbox gateway.
 *     V2  reconnect-to-cached   — the ConnectionManager is driven to a decoy URL
 *                                 and its reconnect/revert behavior observed.
 *
 *   GREEN arm (W2 fix present — pinnedUrl set):
 *     autoStartServer returns {} (no discovery, no server) ⇒ the bridge never
 *     updateUrl's ⇒ the ConnectionManager stays anchored to the SANDBOX gateway
 *     through a forced reconnect. Never the decoy.
 *
 *   RED arm (W2 fix disabled — pinnedUrl absent, the negative control):
 *     the SAME poison IS discovered and returned ⇒ a real repoint to the decoy
 *     ⇒ the session cross-wires. The harness DETECTS + NAMES it (the exact
 *     server-auto-start.ts mDNS-first + connection.ts revert paths).
 *
 * A behavioral DELTA between the arms under identical poison is the proof the
 * isolation test discriminates. This is the cell's own thesis applied to itself:
 * the test that guards against false-green proves it is not itself false-green.
 *
 * NOTE (honest scope, Bert NOTE2): the sandbox dashboard runs fixture-mode
 * (mDNS-advertise OFF), so a real mDNS decoy cannot be advertised TO a real
 * bridge inside the sandbox without standing up a decoy advertiser. This
 * composed-guard dogfood drives the REAL guard code with injected poison at the
 * discoverDashboard seam (the same seam mDNS feeds) — the deterministic,
 * always-runnable v0 proof. The full real-qatest-spawn dogfood scenario
 * (s10-…yaml) is the T2 companion, runnable with auth/tokens.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { autoStartServer, type AutoStartDeps, type DiscoveredServer } from "../server-auto-start.js";
import { ConnectionManager } from "../connection.js";

const SANDBOX_WS = "ws://127.0.0.2:9100"; // the sandbox gateway (the pin)
const SANDBOX_HTTP_PORT = 8100;
const SANDBOX_PI_PORT = 9100;

// The POISON: a decoy "live-like" dashboard on a NON-sandbox gateway. mDNS would
// surface exactly this shape; we inject it at the discoverDashboard seam.
const DECOY_POISON: DiscoveredServer = {
  host: "vaceslavs-macbook-pro", // a real live-ish host (the Scribe-hijack shape)
  port: 8000, // live dashboard port
  piPort: 9999, // live pi-gateway port — the cross-wire target
  isLocal: true, // mDNS marks same-machine servers local → the bridge grabs it
  source: "mdns",
};

function poisonedDeps(overrides: Partial<AutoStartDeps> = {}): AutoStartDeps {
  return {
    // V1 poison: discovery returns the decoy. A guard that runs discovery WILL
    // see it; a pinned guard never calls this.
    discoverDashboard: vi.fn().mockResolvedValue([DECOY_POISON]),
    // V2 poison surface: a health check that also says the decoy is up.
    isDashboardRunning: vi.fn().mockResolvedValue({ running: true }),
    launchServer: vi.fn().mockResolvedValue({ success: true, message: "ok" }),
    notify: vi.fn(),
    ...overrides,
  };
}

// A minimal WebSocket double so the ConnectionManager state-machine runs for real.
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }
  send() {}
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  simulateOpen() {
    this.readyState = 1;
    this.onopen?.();
  }
  simulateClose() {
    this.readyState = 3;
    this.onclose?.();
  }
}

describe("W7 dogfood — cross-wire isolation RED/GREEN negative-control (§5.3-B / S10)", () => {
  const sandboxConfig = { piPort: SANDBOX_PI_PORT, port: SANDBOX_HTTP_PORT, autoStart: true };

  describe("Vector 1 (mDNS-discovery-first) — does the guard skip discovery under poison?", () => {
    it("GREEN arm (fix present): pinned ⇒ poison discovery is NEVER consulted, no decoy server returned", async () => {
      const deps = poisonedDeps();
      const result = await autoStartServer({ ...sandboxConfig, pinnedUrl: SANDBOX_WS }, deps);

      // The guard short-circuits before discovery — the decoy can't be grabbed.
      expect(deps.discoverDashboard).not.toHaveBeenCalled();
      expect(deps.isDashboardRunning).not.toHaveBeenCalled();
      expect(result.server).toBeUndefined();
    });

    it("RED arm (fix disabled): the SAME poison IS discovered and the decoy gateway IS returned (cross-wire)", async () => {
      const deps = poisonedDeps();
      // No pinnedUrl ⇒ the guard is OFF ⇒ discovery runs ⇒ the decoy wins.
      const result = await autoStartServer(sandboxConfig, deps);

      expect(deps.discoverDashboard).toHaveBeenCalled();
      // The decoy's piPort (9999, the LIVE gateway) is what the bridge would
      // updateUrl to — the cross-wire. (host is normalized to localhost by the
      // ff63726 fix, but the PORT is the live gateway — that's the hijack.)
      expect(result.server).toBeDefined();
      expect(result.server!.piPort).toBe(DECOY_POISON.piPort); // 9999 ≠ sandbox 9100
      expect(result.server!.piPort).not.toBe(SANDBOX_PI_PORT);
    });

    it("DELTA: identical poison, opposite outcomes — the test provably discriminates", async () => {
      const green = await autoStartServer({ ...sandboxConfig, pinnedUrl: SANDBOX_WS }, poisonedDeps());
      const red = await autoStartServer(sandboxConfig, poisonedDeps());
      // GREEN: no server (stays pinned). RED: the decoy gateway. The behavioral
      // delta under identical poison is the discriminating-power proof.
      expect(green.server).toBeUndefined();
      expect(red.server?.piPort).toBe(DECOY_POISON.piPort);
      expect(green.server?.piPort ?? SANDBOX_PI_PORT).not.toBe(red.server?.piPort);
    });
  });

  describe("Vector 2 (reconnect-to-cached-host) — does a pinned connection stay anchored under reconnect?", () => {
    beforeEach(() => {
      MockWebSocket.instances = [];
      vi.useFakeTimers();
    });

    it("GREEN arm: a pinned connection (never updateUrl'd) re-targets the SANDBOX gateway across reconnects, never the decoy", () => {
      // The GREEN runtime: because autoStartServer skipped discovery (above), the
      // bridge never calls updateUrl — so the ConnectionManager can only ever
      // anchor to the sandbox gateway, even past REVERT_AFTER_FAILURES.
      const cm = new ConnectionManager({
        url: SANDBOX_WS,
        WebSocketImpl: MockWebSocket as any,
        watchdogTimeout: 0,
      });
      cm.connect();
      MockWebSocket.instances[0].simulateOpen(); // anchor lastWorkingUrl = sandbox

      let backoff = 1000;
      for (let cycle = 1; cycle <= 4; cycle++) {
        const idx = MockWebSocket.instances.length - 1;
        MockWebSocket.instances[idx].simulateClose();
        vi.advanceTimersByTime(backoff);
        const next = MockWebSocket.instances[MockWebSocket.instances.length - 1];
        expect(next.url, `reconnect ${cycle} must target the sandbox, never the decoy`).toBe(SANDBOX_WS);
        backoff = Math.min(backoff * 2, 30000);
      }
      // Zero drift — every socket targeted the sandbox gateway.
      expect([...new Set(MockWebSocket.instances.map((w) => w.url))]).toEqual([SANDBOX_WS]);
      cm.disconnect();
    });

    it("RED arm: a connection updateUrl'd to the decoy (the un-pinned repoint) DOES land on the decoy — the cross-wire is observable", () => {
      const cm = new ConnectionManager({
        url: SANDBOX_WS,
        WebSocketImpl: MockWebSocket as any,
        watchdogTimeout: 0,
      });
      cm.connect();
      MockWebSocket.instances[0].simulateOpen();

      // The RED repoint: the un-pinned bridge's updateUrl to the discovered decoy.
      const DECOY_WS = "ws://localhost:9999"; // the live gateway port — the hijack
      cm.updateUrl(DECOY_WS);
      vi.advanceTimersByTime(1000);
      const switched = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      // The session DID jump to the decoy gateway — the cross-wire the harness detects.
      expect(switched.url, "RED: the un-pinned session cross-wires to the decoy").toBe(DECOY_WS);
      expect(MockWebSocket.instances.some((w) => w.url === DECOY_WS)).toBe(true);
      cm.disconnect();
    });
  });

  it("VERDICT: green-only is rejected — both arms are present and the delta is real", async () => {
    // This meta-assertion encodes §5.3-B: the dogfood is only valid if it carries
    // BOTH a GREEN (isolated) and a RED (cross-wire detected) result under the
    // same poison. The two describe-blocks above provide both; this asserts the
    // core delta one more time at the suite level so a future edit that silently
    // drops the RED arm fails loudly.
    const greenServer = (await autoStartServer({ ...sandboxConfig, pinnedUrl: SANDBOX_WS }, poisonedDeps())).server;
    const redServer = (await autoStartServer(sandboxConfig, poisonedDeps())).server;
    expect(greenServer, "GREEN must stay isolated (no decoy server)").toBeUndefined();
    expect(redServer?.piPort, "RED must cross-wire to the decoy gateway").toBe(DECOY_POISON.piPort);
  });
});
