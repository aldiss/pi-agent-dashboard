import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConnectionManager } from "../connection.js";

// Mock WebSocket (same pattern as connection.test.ts)
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sentMessages: string[] = [];

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sentMessages.push(data);
  }

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

  simulateMessage(data: string) {
    this.onmessage?.({ data });
  }
}

describe("ConnectionManager watchdog", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.useFakeTimers();
  });

  it("should force-close when no messages received for watchdogTimeout", () => {
    const cm = new ConnectionManager({
      url: "ws://localhost:9999",
      WebSocketImpl: MockWebSocket as any,
      watchdogTimeout: 60_000,
    });
    cm.connect();

    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();

    // Advance past watchdog timeout (checked every 15s)
    vi.advanceTimersByTime(60_000);

    // Watchdog should have triggered — ws should be closed and reconnect scheduled
    expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(1);
    // The connection should have been torn down
    expect(cm.isConnected).toBe(false);

    cm.disconnect();
  });

  it("should NOT force-close when messages are received regularly", () => {
    const cm = new ConnectionManager({
      url: "ws://localhost:9999",
      WebSocketImpl: MockWebSocket as any,
      watchdogTimeout: 60_000,
    });
    cm.connect();

    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();

    // Send messages every 20s to keep watchdog happy
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(20_000);
      ws.simulateMessage(JSON.stringify({ type: "heartbeat_ack" }));
    }

    // Should still be connected (100s elapsed, but messages kept coming)
    expect(cm.isConnected).toBe(true);
    expect(MockWebSocket.instances).toHaveLength(1);

    cm.disconnect();
  });

  it("should stop watchdog on disconnect", () => {
    const cm = new ConnectionManager({
      url: "ws://localhost:9999",
      WebSocketImpl: MockWebSocket as any,
      watchdogTimeout: 60_000,
    });
    cm.connect();

    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();

    // Disconnect before watchdog fires
    cm.disconnect();

    // Advance past timeout — should not create new connections
    vi.advanceTimersByTime(120_000);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("should be disabled when watchdogTimeout is 0", () => {
    const cm = new ConnectionManager({
      url: "ws://localhost:9999",
      WebSocketImpl: MockWebSocket as any,
      watchdogTimeout: 0,
    });
    cm.connect();

    const ws = MockWebSocket.instances[0];
    ws.simulateOpen();

    // Advance way past any timeout — should stay connected
    vi.advanceTimersByTime(300_000);
    expect(cm.isConnected).toBe(true);
    expect(MockWebSocket.instances).toHaveLength(1);

    cm.disconnect();
  });

  it("Patch A — recovers stuck-disconnected state when reconnect timer is lost", () => {
    // Regression: 2026-06-02 dashboard drift. Bridge enters handleDisconnect
    // (ws=null, intentionalClose=false), scheduleReconnect's setTimeout is
    // armed but then orphaned (event-loop stall during heavy LLM streaming
    // concurrent with a dashboard-server restart). Without Patch A the
    // bridge would sit forever with no socket and no pending reconnect.
    // With Patch A the watchdog tick (every 15s) detects the
    // stuck-disconnected state and re-arms scheduleReconnect.
    const cm = new ConnectionManager({
      url: "ws://localhost:9999",
      WebSocketImpl: MockWebSocket as any,
      watchdogTimeout: 60_000,
    });
    cm.connect();
    const ws1 = MockWebSocket.instances[0];
    ws1.simulateOpen();
    expect(MockWebSocket.instances.length).toBe(1);

    // Forge the stuck-disconnected state via reflection: simulate the
    // exact failure mode where handleDisconnect ran (ws=null) but the
    // scheduleReconnect setTimeout was lost (reconnectTimer=null), and
    // intentionalClose stays false. The watchdog setInterval (armed by
    // connect() and, after Patch B, by the constructor) survives this
    // scenario because it is a real OS-level timer untouched by the stall.
    (cm as any).ws = null;
    (cm as any).intentionalClose = false;
    (cm as any).reconnectTimer = null;
    expect(cm.isConnected).toBe(false);

    // Advance one watchdog interval (15s). Patch A's new guard fires:
    // !ws && !intentionalClose && reconnectTimer===null → scheduleReconnect.
    vi.advanceTimersByTime(15_000);

    // Backoff 1s elapses, createConnection runs, new WS appears.
    vi.advanceTimersByTime(1000);
    expect(MockWebSocket.instances.length).toBe(2);

    const ws2 = MockWebSocket.instances[1];
    ws2.simulateOpen();
    expect(cm.isConnected).toBe(true);

    cm.disconnect();
  });

  it("Patch B — watchdog is armed from constructor even before connect()", () => {
    // Regression: bridge re-init paths disconnect previous ConnectionManager
    // (latching intentionalClose=true on the old one) and create a fresh
    // ConnectionManager but the subsequent session_start that would call
    // connect() may never re-fire. Without Patch B the fresh manager would
    // sit with no watchdog, no socket, no recovery. With Patch B the
    // watchdog is armed in the constructor and can drive recovery via
    // Patch A's stuck-disconnected guard.
    const cm = new ConnectionManager({
      url: "ws://localhost:9999",
      WebSocketImpl: MockWebSocket as any,
      watchdogTimeout: 60_000,
    });
    // Note: connect() intentionally NOT called.

    // Advance one watchdog interval. Patch A guard sees ws=null,
    // intentionalClose=false (constructor default), reconnectTimer=null
    // → schedules reconnect.
    vi.advanceTimersByTime(15_000);
    // Backoff 1s.
    vi.advanceTimersByTime(1000);

    // A WebSocket was created without ever calling connect() — proves
    // the constructor-armed watchdog drove the recovery.
    expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(1);

    cm.disconnect();
  });

  it("Patch C — scheduleReconnect is single-armed (clears prior timer on re-entry)", () => {
    // If two paths reach scheduleReconnect without going through
    // handleDisconnect first (e.g. Patch A's watchdog guard racing a
    // late onerror), only one timer should be live. We assert this by
    // observing that double-scheduling does not double-spawn WebSockets.
    const cm = new ConnectionManager({
      url: "ws://localhost:9999",
      WebSocketImpl: MockWebSocket as any,
      watchdogTimeout: 0, // disable watchdog to isolate scheduleReconnect behavior
    });
    cm.connect();
    const ws1 = MockWebSocket.instances[0];
    ws1.simulateOpen();
    ws1.simulateClose();
    expect(cm.isConnected).toBe(false);

    // The first scheduleReconnect was called by handleDisconnect (1s backoff).
    // Re-enter scheduleReconnect via reflection — simulating Patch A's guard
    // firing concurrently with the existing pending reconnect.
    (cm as any).scheduleReconnect();

    // Advance enough for any pending reconnect to fire.
    vi.advanceTimersByTime(5000);

    // Exactly one new WS should have been created (ws1 + ws2 = 2 total),
    // proving the double-scheduling collapsed into a single armed timer.
    expect(MockWebSocket.instances.length).toBe(2);

    cm.disconnect();
  });

  it("should reconnect after watchdog triggers", () => {
    const onReconnect = vi.fn();
    const cm = new ConnectionManager({
      url: "ws://localhost:9999",
      WebSocketImpl: MockWebSocket as any,
      watchdogTimeout: 60_000,
      onReconnect,
    });
    cm.connect();

    const ws1 = MockWebSocket.instances[0];
    ws1.simulateOpen();

    // Let watchdog trigger
    vi.advanceTimersByTime(60_000);
    expect(cm.isConnected).toBe(false);

    // Reconnect timer fires (1s backoff)
    vi.advanceTimersByTime(1000);
    expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(2);

    // Simulate successful reconnect
    const ws2 = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    ws2.simulateOpen();
    expect(cm.isConnected).toBe(true);
    expect(onReconnect).toHaveBeenCalled();

    cm.disconnect();
  });
});
