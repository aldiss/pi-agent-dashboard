/**
 * Regression test for browser-gateway sendTo() resilience to JSON.stringify
 * failure (the operator-observed "история сессий по кругу прогружается"
 * symptom on 2026-06-02).
 *
 * Live failure mode prior to this fix:
 *   1. A subscription handler accumulated a large `event_replay` payload
 *      (multi-MB session catch-up batch) and called sendTo.
 *   2. sendTo did `ws.send(JSON.stringify(msg))` with no try/catch.
 *   3. JSON.stringify threw `RangeError: Invalid string length` when the
 *      payload exceeded V8's hard ~512MB string cap.
 *   4. The throw escaped sendTo, was caught by the dashboard's process-level
 *      [crash-safety] uncaughtException handler, but left per-WS replay
 *      bookkeeping half-cleared.
 *   5. The next subscribe re-issued the same oversized replay, throwing
 *      again, in a tight reconnect loop that bled into every connected
 *      browser as "history reloading forever."
 *
 * Fix: wrap JSON.stringify in try/catch. Drop the message + emit a structured
 * `[browser-gw] sendTo: JSON.stringify failed` log line so operators can
 * identify the offending session.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { createBrowserGateway } from "../browser-gateway.js";
import { createMemorySessionManager } from "../memory-session-manager.js";
import { createMemoryEventStore } from "../memory-event-store.js";
import type { PiGateway } from "../pi-gateway.js";

function makeFakeWs() {
  const ws = new EventEmitter() as EventEmitter & {
    send: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    readyState: number;
    OPEN: number;
    bufferedAmount: number;
  };
  ws.send = vi.fn();
  ws.close = vi.fn();
  ws.readyState = 1;
  ws.OPEN = 1;
  ws.bufferedAmount = 0;
  return ws;
}

function makeStubPiGateway(): PiGateway {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    sendToSession: vi.fn(),
    getConnectedSessionIds: vi.fn(() => []),
    hasSession: vi.fn(() => false),
    onEvent: vi.fn(),
  } as unknown as PiGateway;
}

describe("browser-gateway sendTo — JSON.stringify failure resilience", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let stringifySpy: ReturnType<typeof vi.spyOn> | null;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    stringifySpy = null;
  });

  afterEach(() => {
    errorSpy.mockRestore();
    stringifySpy?.mockRestore();
  });

  it("does NOT crash and DOES log when JSON.stringify throws RangeError", async () => {
    const gateway = createBrowserGateway(
      createMemorySessionManager(),
      createMemoryEventStore(() => false),
      makeStubPiGateway(),
    );

    // Stub JSON.stringify to throw RangeError on every call (including the
    // initial snapshot sent on connection). This faithfully reproduces the
    // V8 "Invalid string length" failure mode from the live dashboard log.
    stringifySpy = vi.spyOn(JSON, "stringify").mockImplementation(() => {
      throw new RangeError("Invalid string length");
    });

    const ws = makeFakeWs();

    // The connection-time snapshot path calls sendTo immediately. Pre-fix
    // this would throw an uncaught RangeError out of the connection handler.
    expect(() => gateway.wss.emit("connection", ws, {})).not.toThrow();
    await new Promise((r) => setImmediate(r));

    // Diagnostic log emitted at least once.
    const stringifyErrorCall = errorSpy.mock.calls.find(
      (args: unknown[]) =>
        typeof args[0] === "string" &&
        args[0].includes("[browser-gw] sendTo: JSON.stringify failed"),
    );
    expect(
      stringifyErrorCall,
      "expected a [browser-gw] sendTo: JSON.stringify failed log line",
    ).toBeTruthy();

    // Critically: ws.send was NOT called with garbage (sendTo bailed out).
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("still calls ws.send normally when JSON.stringify succeeds", async () => {
    const gateway = createBrowserGateway(
      createMemorySessionManager(),
      createMemoryEventStore(() => false),
      makeStubPiGateway(),
    );

    const ws = makeFakeWs();
    gateway.wss.emit("connection", ws, {});
    await new Promise((r) => setImmediate(r));

    // Snapshot path sent at least one frame (sessions_snapshot or similar).
    expect(ws.send).toHaveBeenCalled();
    // And we did NOT emit the failure-diagnostic.
    const stringifyErrorCall = errorSpy.mock.calls.find(
      (args: unknown[]) =>
        typeof args[0] === "string" &&
        args[0].includes("[browser-gw] sendTo: JSON.stringify failed"),
    );
    expect(stringifyErrorCall).toBeUndefined();
  });
});
