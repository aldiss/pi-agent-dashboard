/**
 * Pin for the perMessageDeflate lever (2026-06-07 slow-load diagnostic).
 *
 * The `sessions_snapshot` frame is ~345 KB uncompressed at ~380 sessions and
 * re-ships on every (re)connect; gzip of the identical payload is ~46 KB
 * (7.4× smaller). The win depends entirely on the browser gateway's
 * WebSocketServer being constructed with `perMessageDeflate` so the ws client
 * negotiates compression at handshake time.
 *
 * Two layers of pin:
 *   1. Config pin — the real gateway's `wss.options.perMessageDeflate` exposes
 *      `threshold: 1024` (only compress frames > 1 KB; skip control frames).
 *   2. End-to-end pin — a real `ws` client connecting through the production
 *      upgrade path negotiates the `permessage-deflate` extension. A plain
 *      WebSocketServer (no perMessageDeflate) is the negative control proving
 *      the assertion is not a tautology.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import http from "node:http";
import { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import { createBrowserGateway } from "../browser-gateway.js";
import { createMemorySessionManager } from "../memory-session-manager.js";
import { createMemoryEventStore } from "../memory-event-store.js";
import type { PiGateway } from "../pi-gateway.js";

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

/** Wire a WebSocketServer onto an http server's upgrade event, mirroring server.ts. */
function listenOn(wss: WebSocketServer): Promise<{ port: number; server: http.Server }> {
  const server = http.createServer();
  server.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ port: (server.address() as AddressInfo).port, server });
    });
  });
}

/** Open a perMessageDeflate-capable client and resolve its negotiated extensions string. */
function negotiatedExtensions(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}`, { perMessageDeflate: true });
    client.on("open", () => {
      const ext = String(client.extensions);
      client.close();
      resolve(ext);
    });
    client.on("error", reject);
  });
}

describe("browser-gateway perMessageDeflate", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it("constructs its WebSocketServer with perMessageDeflate threshold 1024", () => {
    const gateway = createBrowserGateway(
      createMemorySessionManager(),
      createMemoryEventStore(() => false),
      makeStubPiGateway(),
    );
    cleanups.push(() => gateway.wss.close());

    const opts = gateway.wss.options.perMessageDeflate as { threshold?: number } | boolean;
    expect(typeof opts).toBe("object");
    expect((opts as { threshold?: number }).threshold).toBe(1024);
  });

  it("negotiates the permessage-deflate extension with a real ws client", async () => {
    const gateway = createBrowserGateway(
      createMemorySessionManager(),
      createMemoryEventStore(() => false),
      makeStubPiGateway(),
    );
    const { port, server } = await listenOn(gateway.wss);
    cleanups.push(() => { gateway.wss.close(); server.close(); });

    const ext = await negotiatedExtensions(port);
    expect(ext).toContain("permessage-deflate");
  });

  it("does NOT negotiate deflate when the server omits perMessageDeflate (negative control)", async () => {
    const plain = new WebSocketServer({ noServer: true });
    const { port, server } = await listenOn(plain);
    cleanups.push(() => { plain.close(); server.close(); });

    const ext = await negotiatedExtensions(port);
    expect(ext).not.toContain("permessage-deflate");
  });
});
