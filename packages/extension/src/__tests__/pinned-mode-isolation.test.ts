/**
 * GATE-REQUIRED pinned-mode isolation invariant test-set.
 *
 * This is the named test-set the real-e2e land gate requires green before an
 * `e2e-suite-pass` is valid (design-pass §5.3-A). It asserts the
 * `PI_DASHBOARD_URL`-pinned contract at the unit/integration tier — fast,
 * deterministic, no live cross-wire needed — closing BOTH cross-wire vectors
 * that hijacked the live crew tonight (dl-2942 / dl-2976):
 *
 *   Vector 1 — mDNS-discovery-first (server-auto-start.ts:59-61): a pinned
 *              session must perform NO discovery and NO auto-start.
 *   Vector 2 — reconnect-to-cached-host (connection.ts:282): a pinned session
 *              must NEVER be `updateUrl`'d away from its pin, so a forced
 *              reconnect always re-targets the pin (covers RECONNECT, not just
 *              the initial connect — Bert NOTE1).
 *
 * The guard composes on top of the deployed ff63726 mDNS-hardening base; it is
 * an ORTHOGONAL isolation layer (ff63726 fixes 0-bridge/DNS-unresolvable, NOT
 * isolation — its localhost-resolve actually makes a wrong-dashboard connection
 * SUCCEED, so isolation cannot lean on a bad connection failing).
 *
 * If any test here is red or absent, the e2e-suite-pass is REJECTED.
 *
 * See: nos-real-e2e-test-infrastructure/v1 design-pass §1.2, §5.3-A.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";
import {
  autoStartServer,
  type AutoStartDeps,
  type DiscoveredServer,
} from "../server-auto-start.js";
import { ConnectionManager } from "../connection.js";

const PINNED_URL = "ws://127.0.0.2:9100";
const baseConfig = { piPort: 9100, port: 8100, autoStart: true };

function makeDeps(overrides: Partial<AutoStartDeps> = {}): AutoStartDeps {
  return {
    discoverDashboard: vi.fn().mockResolvedValue([]),
    isDashboardRunning: vi.fn().mockResolvedValue({ running: false }),
    launchServer: vi.fn().mockResolvedValue({ success: true, message: "ok" }),
    notify: vi.fn(),
    ...overrides,
  };
}

// Minimal WebSocket double — mirrors connection.test.ts so the reconnect
// state-machine (backoff timers, onopen anchoring, revert branch) runs for real.
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

describe("pinned-mode isolation invariants (GATE-REQUIRED — design-pass §5.3-A)", () => {
  // ──────────────────────────────────────────────────────────────────────
  // INVARIANT 1 — no-discover: PI_DASHBOARD_URL set ⇒ no discovery, no
  // auto-start (Vector 1).
  // ──────────────────────────────────────────────────────────────────────
  describe("INVARIANT 1 (no-discover): pinned ⇒ autoStartServer does NO discovery and NO auto-start", () => {
    it("never calls discoverDashboard / isDashboardRunning / launchServer when pinnedUrl is set", async () => {
      const deps = makeDeps();
      const result = await autoStartServer({ ...baseConfig, pinnedUrl: PINNED_URL }, deps);

      expect(deps.discoverDashboard).not.toHaveBeenCalled();
      expect(deps.isDashboardRunning).not.toHaveBeenCalled();
      expect(deps.launchServer).not.toHaveBeenCalled();
      // Empty result ⇒ caller keeps its constructed (pinned) URL.
      expect(result.server).toBeUndefined();
    });

    it("returns NO server even when a poison local dashboard is advertised on a different port", async () => {
      // Adversarial: mDNS is advertising a decoy live-like dashboard that,
      // absent the pin, would be discovered and `updateUrl`'d to (Vector 1).
      const poison: DiscoveredServer = {
        host: "vaceslavs-macbook-pro", port: 8000, piPort: 9999,
        isLocal: true, source: "mdns",
      };
      const deps = makeDeps({
        discoverDashboard: vi.fn().mockResolvedValue([poison]),
        isDashboardRunning: vi.fn().mockResolvedValue({ running: true }),
      });

      const result = await autoStartServer({ ...baseConfig, pinnedUrl: PINNED_URL }, deps);

      // The pin wins: discovery is never even consulted, so the decoy can't
      // become the connection target.
      expect(deps.discoverDashboard).not.toHaveBeenCalled();
      expect(result.server).toBeUndefined();
    });

    it("control: WITHOUT the pin, the SAME poison IS discovered and returned (proves the guard discriminates)", async () => {
      // Negative control for the test itself: if pinning made no difference,
      // invariant 1 would be vacuously green. Here the unpinned call DOES grab
      // the local server — so the pinned skip above is a real behavioural delta.
      const poison: DiscoveredServer = {
        host: "vaceslavs-macbook-pro", port: 8000, piPort: 9999,
        isLocal: true, source: "mdns",
      };
      const deps = makeDeps({
        discoverDashboard: vi.fn().mockResolvedValue([poison]),
      });

      const result = await autoStartServer(baseConfig, deps); // no pinnedUrl

      expect(deps.discoverDashboard).toHaveBeenCalled();
      expect(result.server).toEqual({ host: "localhost", port: 8000, piPort: 9999 });
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // INVARIANT 2 — no-updateUrl: the pinned connection is never repointed.
  // ──────────────────────────────────────────────────────────────────────
  describe("INVARIANT 2 (no-updateUrl): the pinned connection is never updateUrl'd away", () => {
    it("autoStartServer returns no server in pinned mode, so the bridge's only updateUrl gate stays false", async () => {
      // The bridge repoints ONLY inside `if (result.server && result.server.piPort
      // !== config.piPort) connection.updateUrl(...)`. A pinned result has no
      // `server`, so that branch can never run — the connection keeps its pin.
      const deps = makeDeps({
        // Even a discovery that returns a different piPort can't matter: the
        // guard returns before discovery runs.
        discoverDashboard: vi.fn().mockResolvedValue([
          { host: "localhost", port: 8000, piPort: 9998, isLocal: true, source: "mdns" },
        ]),
      });

      const result = await autoStartServer({ ...baseConfig, pinnedUrl: PINNED_URL }, deps);

      const wouldRepoint = Boolean(result.server && result.server.piPort !== baseConfig.piPort);
      expect(wouldRepoint).toBe(false);
    });

    it("ANTIBODY (Bert NOTE1): connection.updateUrl has exactly ONE production caller, gated on result.server", async () => {
      // The whole isolation argument rests on `updateUrl` being the SOLE repoint
      // path AND that path being reachable only via `result.server`. If a future
      // edit adds a second production caller, this invariant set no longer
      // proves isolation — fail loudly here so the gate catches it.
      const here = path.dirname(url.fileURLToPath(import.meta.url));
      const srcDir = path.resolve(here, "..");
      const repoRoot = path.resolve(here, "..", "..", "..", "..");

      const callers: Array<{ file: string; line: number; text: string }> = [];
      const re = /(?:^|[^.\w])\w*\.updateUrl\s*\(/;

      async function* walk(dir: string): AsyncGenerator<string> {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            // Exclude __tests__ (test doubles legitimately call updateUrl) and
            // build output.
            if (["node_modules", "dist", "__tests__"].includes(entry.name)) continue;
            yield* walk(full);
          } else if (entry.isFile() && /\.(ts|tsx|mts|cts)$/.test(entry.name)) {
            yield full;
          }
        }
      }

      for await (const file of walk(srcDir)) {
        const content = await fs.readFile(file, "utf-8");
        content.split(/\r?\n/).forEach((lineText, idx) => {
          // The definition site (connection.ts) is `updateUrl(newUrl: string)`
          // with no leading `.` — the regex requires a `.` receiver, so the
          // definition is not matched. Only call sites `x.updateUrl(` match.
          if (re.test(lineText)) {
            callers.push({ file: path.relative(repoRoot, file), line: idx + 1, text: lineText.trim() });
          }
        });
      }

      const msg =
        `connection.updateUrl MUST have exactly ONE production caller (the bridge ` +
        `autoStartServer().then repoint, gated on result.server). Found ${callers.length}:\n` +
        callers.map((c) => `  ${c.file}:${c.line}  ${c.text}`).join("\n") +
        `\n\nIf you added a repoint path, the pinned-mode isolation proof no longer ` +
        `holds — route it through the pinnedUrl guard or update design-pass §1.2.`;

      expect(callers.length, msg).toBe(1);
      expect(callers[0].file, msg).toMatch(/bridge\.ts$/);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // INVARIANT 3 — forced-reconnect-stays-pinned: lastWorkingUrl == pinned URL
  // across kill/reconnect cycles (Vector 2, Bert NOTE1 "reconnect not just
  // connect").
  // ──────────────────────────────────────────────────────────────────────
  describe("INVARIANT 3 (forced-reconnect-stays-pinned): a pinned ConnectionManager re-targets the pin across reconnects", () => {
    beforeEach(() => {
      MockWebSocket.instances = [];
      vi.useFakeTimers();
    });

    it("every reconnect re-targets the pinned URL, even past REVERT_AFTER_FAILURES, when updateUrl is never called", () => {
      // This mirrors the bridge's pinned runtime: the ConnectionManager is
      // constructed with the pinned URL and — because autoStartServer skips
      // discovery — `updateUrl` is NEVER invoked. The revert branch
      // (connection.ts:282) is gated on `url !== lastWorkingUrl`; with no
      // updateUrl that condition is permanently false, so the session can only
      // ever anchor to the pin.
      const cm = new ConnectionManager({
        url: PINNED_URL,
        WebSocketImpl: MockWebSocket as any,
        watchdogTimeout: 0, // disable watchdog noise in fake-timer land
      });
      cm.connect();

      // Initial connect to the pin succeeds — anchors lastWorkingUrl = pin.
      expect(MockWebSocket.instances).toHaveLength(1);
      expect(MockWebSocket.instances[0].url).toBe(PINNED_URL);
      MockWebSocket.instances[0].simulateOpen();

      // Drive 5 disconnect→reconnect cycles. 5 > REVERT_AFTER_FAILURES (3): a
      // session that had been updateUrl'd away would by now have reverted to a
      // *different* lastWorkingUrl. A pinned session has nowhere else to go.
      let backoff = 1000;
      for (let cycle = 1; cycle <= 5; cycle++) {
        const idx = MockWebSocket.instances.length - 1;
        MockWebSocket.instances[idx].simulateClose();
        vi.advanceTimersByTime(backoff);
        const next = MockWebSocket.instances[MockWebSocket.instances.length - 1];
        expect(next.url, `reconnect cycle ${cycle} must target the pin`).toBe(PINNED_URL);
        backoff = Math.min(backoff * 2, 30000);
      }

      // Every socket ever created targeted the pin — zero drift.
      const distinctUrls = [...new Set(MockWebSocket.instances.map((w) => w.url))];
      expect(distinctUrls).toEqual([PINNED_URL]);

      cm.disconnect();
    });

    it("control: a session that IS updateUrl'd away reverts to a DIFFERENT url (proves the test can see drift)", () => {
      // Negative control: the same harness, but we deliberately updateUrl to a
      // dead endpoint. After REVERT_AFTER_FAILURES the connection reverts — to
      // the original anchor, NOT the switched URL. This proves invariant 3's
      // assertion is not vacuous: when drift exists, the harness observes it.
      const cm = new ConnectionManager({
        url: PINNED_URL,
        WebSocketImpl: MockWebSocket as any,
        watchdogTimeout: 0,
      });
      cm.connect();
      MockWebSocket.instances[0].simulateOpen(); // anchor lastWorkingUrl = pin

      const DECOY = "ws://10.0.0.9:9999";
      cm.updateUrl(DECOY); // failure #1 (force-disconnect + arm reconnect)
      vi.advanceTimersByTime(1000);
      expect(MockWebSocket.instances[1].url).toBe(DECOY); // switched

      // Decoy keeps failing; revert trips on the 3rd failure.
      MockWebSocket.instances[1].simulateClose(); // #2
      vi.advanceTimersByTime(2000);
      MockWebSocket.instances[2].simulateClose(); // #3 → revert to pin
      vi.advanceTimersByTime(4000);

      const last = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      expect(last.url, "after revert the connection returns to the original anchor").toBe(PINNED_URL);
      // And the harness DID see the decoy mid-flight — drift is observable.
      expect(MockWebSocket.instances.some((w) => w.url === DECOY)).toBe(true);

      cm.disconnect();
    });
  });
});
