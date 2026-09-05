import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionManager } from "../connection.js";

const { readBridgeToken } = vi.hoisted(() => ({ readBridgeToken: vi.fn() }));

vi.mock("@blackbelt-technology/pi-dashboard-shared/bridge-token.js", () => ({ readBridgeToken }));

describe("ConnectionManager bridge token presentation", () => {
  const connections: ConnectionManager[] = [];
  const token = "a".repeat(64);
  const WebSocketImpl = vi.fn(function () {
    return {
      readyState: 0,
      close: vi.fn(),
      send: vi.fn(),
      onopen: null as (() => void) | null,
      onclose: null as (() => void) | null,
    };
  });

  function connect(url = "ws://localhost:9999") {
    const connection = new ConnectionManager({ url, WebSocketImpl, watchdogTimeout: 0 });
    connections.push(connection);
    connection.connect();
    return connection;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    WebSocketImpl.mockClear();
    readBridgeToken.mockReset().mockReturnValue(token);
  });

  afterEach(() => {
    for (const connection of connections.splice(0)) connection.disconnect();
    vi.useRealTimers();
  });

  it.each([
    "ws://localhost:9999",
    "wss://LOCALHOST:9999",
    "ws://127.0.0.1:9999",
    "ws://127.12.34.56:9999",
    "ws://[::1]:9999",
    "ws://[0:0:0:0:0:0:0:1]:9999",
    "ws://[::ffff:127.0.0.1]:9999",
  ])("presents the token as subprotocols to loopback %s", (url) => {
    connect(url);

    expect(WebSocketImpl).toHaveBeenCalledWith(url, ["pi-bridge", `pi-bridge-token.${token}`]);
    expect(readBridgeToken).toHaveBeenCalledOnce();
  });

  it.each([
    "ws://192.168.16.2:9999",
    "ws://10.0.0.2:9999",
    "wss://dashboard.example:9999",
    "ws://localhost.attacker.example:9999",
    "ws://127.0.0.1.attacker.example:9999",
    "ws://localhost@attacker.example:9999",
    "ws://attacker.example:9999/?host=localhost",
    "ws://bridge.local:9999",
    "ws://0.0.0.0:9999",
    "ws://[2001:db8::1]:9999",
    "ws://[::ffff:192.168.16.2]:9999",
  ])("does not read or transmit the local token to %s", (url) => {
    connect(url);

    expect(WebSocketImpl).toHaveBeenCalledWith(url);
    expect(readBridgeToken).not.toHaveBeenCalled();
  });

  it("keeps the legacy one-argument constructor when no token exists", () => {
    readBridgeToken.mockReturnValue(null);
    connect();

    expect(WebSocketImpl).toHaveBeenCalledWith("ws://localhost:9999");
  });

  it("reads a newly available token on reconnect without changing the URL", () => {
    readBridgeToken.mockReturnValueOnce(null).mockReturnValueOnce(token);
    connect();
    const firstSocket = WebSocketImpl.mock.results[0].value;
    firstSocket.onopen();
    firstSocket.onclose();
    vi.advanceTimersByTime(1000);

    expect(WebSocketImpl).toHaveBeenNthCalledWith(1, "ws://localhost:9999");
    expect(WebSocketImpl).toHaveBeenNthCalledWith(2, "ws://localhost:9999", ["pi-bridge", `pi-bridge-token.${token}`]);
    expect(readBridgeToken).toHaveBeenCalledTimes(2);
  });

  it("does not reuse a token after rotation or removal", () => {
    const rotatedToken = "b".repeat(64);
    readBridgeToken.mockReturnValueOnce(token).mockReturnValueOnce(rotatedToken).mockReturnValueOnce(null);
    connect();
    for (let i = 0; i < 2; i++) {
      const socket = WebSocketImpl.mock.results[i].value;
      socket.onopen();
      socket.onclose();
      vi.advanceTimersByTime(1000);
    }

    expect(WebSocketImpl).toHaveBeenNthCalledWith(2, "ws://localhost:9999", ["pi-bridge", `pi-bridge-token.${rotatedToken}`]);
    expect(WebSocketImpl).toHaveBeenNthCalledWith(3, "ws://localhost:9999");
  });

  it("stops presenting the token after discovery switches to a remote server", () => {
    const connection = connect();
    WebSocketImpl.mock.results[0].value.onopen();
    connection.updateUrl("ws://192.168.16.2:9999");
    vi.advanceTimersByTime(1000);

    expect(WebSocketImpl).toHaveBeenNthCalledWith(2, "ws://192.168.16.2:9999");
    expect(readBridgeToken).toHaveBeenCalledOnce();
  });
});
