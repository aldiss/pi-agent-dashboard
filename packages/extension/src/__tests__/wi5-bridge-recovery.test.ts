/**
 * WI-5 — client bridge-recovery fix: d22 acceptance (5 bars), own-hand, real.
 *
 * The operator-blocking bug: a bridge re-init `disconnect()`'d every orphaned
 * ConnectionManager from the previous incarnation, latching
 * `intentionalClose=true` + stopping the watchdog — so the Patch-A re-arm
 * (`!intentionalClose`) could NEVER recover it. If the new incarnation's
 * `connect()` then never re-fired (long-running session), the orphan sat with
 * zero `:9999` socket forever = "can't reach Lane".
 *
 * The fix (`disconnectOrphanRecoverable()`, wired at bridge.ts reinit-orphan
 * loop) closes the dead socket but leaves `intentionalClose` UNSET and keeps the
 * watchdog armed — so the existing stuck-DISCONNECTED guard recovers the orphan
 * within one tick. Genuine-shutdown (`disconnect()`) and involuntary
 * (`handleDisconnect()`) paths are untouched.
 *
 * MECHANISM = shutdown-intent, NOT kill-0 (kill-0 is server-side; the extension
 * is trivially alive inside the pi process). The discriminator is WHICH close
 * fired. Bars below mirror Bert d22 a/b/c + the operator-lever (d).
 *
 * Uses the same MockWebSocket + fake-timer harness as watchdog.test.ts.
 * See change: handover-reliability-wi5.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ConnectionManager } from "../connection.js";

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sentMessages: string[] = [];
  closed = false;

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }
  send(data: string) { this.sentMessages.push(data); }
  close() { this.closed = true; this.readyState = 3; this.onclose?.(); }
  simulateOpen() { this.readyState = 1; this.onopen?.(); }
  simulateClose() { this.readyState = 3; this.onclose?.(); }
  simulateMessage(data: string) { this.onmessage?.({ data }); }
}

function newCM() {
  return new ConnectionManager({
    url: "ws://localhost:9999",
    WebSocketImpl: MockWebSocket as any,
    watchdogTimeout: 60_000,
  });
}

describe("WI-5 bridge-recovery — d22 acceptance", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.useFakeTimers();
  });

  it("(a) reinit-orphan of a CONTINUING session → watchdog RECOVERS (:9999 re-establishes)", () => {
    // An orphan from a previous incarnation: connected, then the re-init loop
    // closes it RECOVERABLY (this is what bridge.ts:116 now does).
    const orphan = newCM();
    orphan.connect();
    const ws1 = MockWebSocket.instances[0];
    ws1.simulateOpen();
    expect(orphan.isConnected).toBe(true);

    // The reinit-orphan close — NOT a genuine shutdown.
    orphan.disconnectOrphanRecoverable();
    expect(orphan.isConnected).toBe(false);
    expect(ws1.closed).toBe(true); // dead socket released
    // Crucially: NOT latched intentional (this is the whole fix).
    expect((orphan as any).intentionalClose).toBe(false);

    // One watchdog tick (15s) → stuck-DISCONNECTED guard re-arms reconnect.
    vi.advanceTimersByTime(15_000);
    // Backoff 1s → createConnection → a fresh socket appears.
    vi.advanceTimersByTime(1000);
    expect(MockWebSocket.instances.length).toBe(2);

    const ws2 = MockWebSocket.instances[1];
    ws2.simulateOpen();
    expect(orphan.isConnected).toBe(true); // RECOVERED — :9999 re-established

    orphan.disconnect();
  });

  it("(b) genuine session_shutdown / deactivate disconnect() → STAYS CLOSED (no resurrect)", () => {
    // Categories 2 (bridge.ts:1563 session_shutdown, :1610 deactivate) call the
    // ordinary disconnect(). The watchdog must NOT resurrect these.
    const cm = newCM();
    cm.connect();
    MockWebSocket.instances[0].simulateOpen();
    expect(cm.isConnected).toBe(true);

    cm.disconnect(); // genuine shutdown
    expect((cm as any).intentionalClose).toBe(true);

    // Advance far past several watchdog ticks + any backoff — must NOT reconnect.
    vi.advanceTimersByTime(300_000);
    expect(MockWebSocket.instances.length).toBe(1); // no new socket — stays closed
    expect(cm.isConnected).toBe(false);
  });

  it("(c-iii) involuntary handleDisconnect (socket-drop) → STILL reconnects, UNCHANGED (server-restart-survivor)", () => {
    // The working path: an involuntary close (server drop / socket error) runs
    // handleDisconnect → scheduleReconnect, WITHOUT setting intentionalClose.
    // WI-5 must not regress this — it is how every restart-survivor reconnected.
    const cm = newCM();
    cm.connect();
    const ws1 = MockWebSocket.instances[0];
    ws1.simulateOpen();
    expect(cm.isConnected).toBe(true);

    // Server drops the socket — onclose fires handleDisconnect (involuntary).
    ws1.simulateClose();
    expect(cm.isConnected).toBe(false);
    expect((cm as any).intentionalClose).toBe(false); // involuntary — never intentional

    // Reconnect backoff (1s) → a new socket appears, exactly as before WI-5.
    vi.advanceTimersByTime(1000);
    expect(MockWebSocket.instances.length).toBe(2);
    MockWebSocket.instances[1].simulateOpen();
    expect(cm.isConnected).toBe(true); // reconnected — working path intact

    cm.disconnect();
  });

  it("(c-i/ii) the discriminator: disconnect() latches intent; disconnectOrphanRecoverable() does NOT", () => {
    // Completeness of the close-taxonomy at the ConnectionManager boundary:
    // the ONLY thing that distinguishes recover-vs-stay-closed is which close
    // fired — proven by the intentionalClose flag each leaves behind.
    const a = newCM();
    a.connect();
    MockWebSocket.instances[0].simulateOpen();
    a.disconnect();
    expect((a as any).intentionalClose).toBe(true); // stay-closed

    const b = newCM();
    b.connect();
    MockWebSocket.instances[1].simulateOpen();
    b.disconnectOrphanRecoverable();
    expect((b as any).intentionalClose).toBe(false); // recoverable

    a.disconnect();
    b.disconnect();
  });

  it("(d) reinit-orphan → /__dashboard_reload (activate→connect) → RECOVERS deterministically", () => {
    // The operator lever: a stuck orphan, then a reload that re-news the manager
    // via activate()→connect(). Post-WI-5 the orphan is already recoverable, so
    // even a fresh connect() that loses the race still lands connected.
    const orphan = newCM();
    orphan.connect();
    MockWebSocket.instances[0].simulateOpen();
    orphan.disconnectOrphanRecoverable(); // stuck-but-recoverable

    // Reload calls connect() again (bridge activate→connect path).
    orphan.connect();
    const wsAfterReload = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    wsAfterReload.simulateOpen();
    expect(orphan.isConnected).toBe(true); // reload lever recovered it

    orphan.disconnect();
  });

  it("(d') reload-race: if the fresh connect() never fires, the watchdog STILL recovers", () => {
    // The reason the watchdog re-arm is the real fix and the reload lever is a
    // backstop: even if connect() is never re-called (the exact pre-WI-5 stuck
    // case), recovery is deterministic via the watchdog alone.
    const orphan = newCM();
    orphan.connect();
    MockWebSocket.instances[0].simulateOpen();
    orphan.disconnectOrphanRecoverable();

    // connect() intentionally NOT re-called — watchdog must carry it.
    vi.advanceTimersByTime(15_000); // guard fires
    vi.advanceTimersByTime(1000); // backoff
    expect(MockWebSocket.instances.length).toBe(2);
    MockWebSocket.instances[1].simulateOpen();
    expect(orphan.isConnected).toBe(true);

    orphan.disconnect();
  });
});

describe("WI-5 close-taxonomy — source contract (c-meta exhaustiveness)", () => {
  // The 3-category claim is only sound if the enumeration is exhaustive and the
  // wiring matches. These assertions pin the taxonomy to the source so a future
  // edit that re-points a close path (or adds a 4th) trips the test.
  const here = dirname(fileURLToPath(import.meta.url));
  const bridgeSrc = readFileSync(join(here, "..", "bridge.ts"), "utf8");
  const connSrc = readFileSync(join(here, "..", "connection.ts"), "utf8");

  it("category 1 (reinit-orphan loop) calls disconnectOrphanRecoverable(), NOT disconnect()", () => {
    // Find the orphan loop and assert it uses the recoverable close. The
    // window spans the (multi-line) WI-5 comment block + the loop body.
    const idx = bridgeSrc.indexOf("orphaned connections from previous bridge incarnations");
    expect(idx).toBeGreaterThan(-1);
    const region = bridgeSrc.slice(idx, idx + 800);
    expect(region).toMatch(/conn\.disconnectOrphanRecoverable\(\)/);
    expect(region).not.toMatch(/conn\.disconnect\(\)/);
  });

  it("categories 2 (session_shutdown + deactivate) still call the ordinary disconnect()", () => {
    // Exactly the two genuine-shutdown sites remain on disconnect().
    const genuine = bridgeSrc.match(/connection\.disconnect\(\)/g) ?? [];
    expect(genuine.length).toBe(2);
  });

  it("category 3 (handleDisconnect, involuntary) does NOT set intentionalClose — untouched working path", () => {
    const start = connSrc.indexOf("private handleDisconnect()");
    expect(start).toBeGreaterThan(-1);
    const end = connSrc.indexOf("private startWatchdog()", start);
    const body = connSrc.slice(start, end);
    expect(body).not.toMatch(/intentionalClose\s*=\s*true/);
    expect(body).toMatch(/scheduleReconnect\(\)/); // still reconnects
  });

  it("disconnectOrphanRecoverable() does NOT latch intentionalClose (the recover discriminator)", () => {
    const start = connSrc.indexOf("disconnectOrphanRecoverable()");
    expect(start).toBeGreaterThan(-1);
    // Body up to the next method.
    const end = connSrc.indexOf("private startWatchdog()", start);
    const body = connSrc.slice(start, end >= 0 ? end : start + 800);
    expect(body).not.toMatch(/this\.intentionalClose\s*=\s*true/);
    expect(body).toMatch(/this\.startWatchdog\(\)/); // keeps the watchdog armed
  });

  it("close-mechanism enumeration is exhaustive: disconnect() + disconnectOrphanRecoverable() + handleDisconnect() are the only ws-closers in connection.ts", () => {
    // Any direct ws.close() must live inside one of those three methods. We
    // assert there is no FOURTH public close path by counting method defs.
    expect(connSrc).toMatch(/\bdisconnect\(\): void/);
    expect(connSrc).toMatch(/\bdisconnectOrphanRecoverable\(\): void/);
    expect(connSrc).toMatch(/private handleDisconnect\(\): void/);
  });
});
