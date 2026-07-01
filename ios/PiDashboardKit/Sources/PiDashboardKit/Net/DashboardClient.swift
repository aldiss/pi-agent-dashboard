import Foundation

public enum DashboardClientError: Error, Sendable {
    case notConnected
    case badURL
}

/// Live WebSocket client for the dashboard **browser** gateway. Opens the WS,
/// runs a receive loop that decodes `ServerMessage`s, and exposes them as an
/// `AsyncStream`. Mirrors the browser client's transport: connect → receive
/// `sessions_snapshot` → live deltas; `subscribe` a session → `event_replay` +
/// live `event`s; `send_prompt` to compose.
///
/// An `actor` so connection state + the socket task are isolated; the SwiftUI
/// layer wraps it in an `@MainActor` observable store.
public actor DashboardClient {
    public enum ConnectionState: Sendable, Equatable {
        case disconnected, connecting, connected
        case failed(String)
    }

    private let session: URLSession
    private var task: URLSessionWebSocketTask?
    private var continuation: AsyncStream<ServerMessage>.Continuation?
    public private(set) var state: ConnectionState = .disconnected

    public init(session: URLSession = URLSession(configuration: .default)) {
        self.session = session
    }

    /// Map a dashboard base URL (`http(s)://host:port`) to its browser-gateway WS
    /// endpoint (`ws(s)://host:port/ws`). The gateway upgrades at the `/ws` path
    /// (verified against `packages/client/src/App.tsx` + `api-context.ts`).
    public static func websocketURL(base: URL) -> URL? {
        guard var comps = URLComponents(url: base, resolvingAgainstBaseURL: false) else { return nil }
        switch comps.scheme {
        case "https": comps.scheme = "wss"
        case "http": comps.scheme = "ws"
        case "ws", "wss": break
        default: comps.scheme = "ws"
        }
        var path = comps.path
        if path.hasSuffix("/") { path.removeLast() }
        if !path.hasSuffix("/ws") { path += "/ws" }
        comps.path = path
        return comps.url
    }

    /// Connect to the browser gateway and return a stream of decoded server messages.
    /// Re-connecting first tears down any existing socket. The returned stream
    /// FINISHES when the socket drops — the caller (DashboardStore) observes that
    /// end-of-stream to drive its reconnect/backoff + the disconnect banner.
    ///
    /// Ownership note (cc-ios-build): the seed set `state = .connected` synchronously
    /// after `resume()` and the receive loop mutated the actor's `continuation`
    /// without checking it still owned the live socket — so an old loop tearing down
    /// after a reconnect could finish the *new* stream. Reworked to bind the socket
    /// into the loop and identity-gate every shared-state write on `socket === task`.
    public func connect(base: URL, token: String? = nil) -> AsyncStream<ServerMessage> {
        disconnect()
        guard let wsURL = Self.websocketURL(base: base) else {
            state = .failed("invalid server URL")
            return AsyncStream { $0.finish() }
        }
        state = .connecting
        var req = URLRequest(url: wsURL)
        if let token, !token.isEmpty {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let socket = session.webSocketTask(with: req)
        self.task = socket
        let stream = AsyncStream<ServerMessage> { cont in self.continuation = cont }
        socket.resume()
        Task { await self.receiveLoop(socket: socket) }
        return stream
    }

    public func disconnect() {
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        continuation?.finish()
        continuation = nil
        state = .disconnected
    }

    /// Send a client message as a JSON text frame.
    public func send(_ message: ClientMessage) async throws {
        guard let task else { throw DashboardClientError.notConnected }
        let json = try message.jsonString()
        try await task.send(.string(json))
    }

    /// Abort (stop) a running session — the browser-protocol `{ type: "abort",
    /// sessionId }` control message (`AbortToBrowserMessage`). Thin convenience over
    /// `send` so callers express intent directly; the server flips the session
    /// streaming→idle/ended, which arrives as a `session_updated` delta. Throws
    /// `.notConnected` if the socket is down (no silent drop). ABORT only — resume /
    /// spawn are separate controls.
    public func abort(sessionId: String) async throws {
        try await send(.abort(sessionId: sessionId))
    }

    /// Resume (continue) an ended session — the browser-protocol `resume_session`
    /// control (`ResumeSessionBrowserMessage`). `mode` defaults to `"continue"` (the
    /// respawn keeps the same sessionId); `"fork"` is out of scope for this
    /// increment. `placement` is omitted so the server applies its `"front"` default
    /// (the Resume-button trigger). The server sets the session `resuming: true` and
    /// broadcasts a `session_updated` delta, then clears it on failure/timeout or
    /// once the respawned bridge re-registers. Throws `.notConnected` on a dead
    /// socket (no silent drop).
    public func resume(sessionId: String, mode: String = "continue",
                       requestId: String? = nil) async throws {
        try await send(.resumeSession(sessionId: sessionId, mode: mode, requestId: requestId))
    }

    /// Receive loop bound to the socket it was started for. Every write to shared
    /// actor state is gated on `socket === task`; a superseded loop (post-reconnect)
    /// exits silently without touching the live socket's `state`/`continuation`.
    private func receiveLoop(socket: URLSessionWebSocketTask) async {
        while true {
            do {
                let message = try await socket.receive()
                guard socket === task else { return }  // superseded by a reconnect
                if state != .connected { state = .connected }
                switch message {
                case .string(let text): emit(Data(text.utf8))
                case .data(let data): emit(data)
                @unknown default: break
                }
            } catch {
                guard socket === task else { return }  // superseded loop: stay silent
                state = .failed(error.localizedDescription)
                continuation?.finish()
                continuation = nil
                return
            }
        }
    }

    private func emit(_ data: Data) {
        guard let msg = try? JSONDecoder().decode(ServerMessage.self, from: data) else { return }
        continuation?.yield(msg)
    }
}

/// REST client for the dashboard HTTP API. Stateless + `Sendable`. Used by the
/// Connect screen (health probe) and for the initial `/api/sessions` load.
public struct RestClient: Sendable {
    public let base: URL
    public let token: String?
    private let session: URLSession

    public init(base: URL, token: String? = nil, session: URLSession = .shared) {
        self.base = base
        self.token = token
        self.session = session
    }

    private func makeRequest(_ path: String) -> URLRequest {
        var req = URLRequest(url: base.appendingPathComponent(path))
        if let token, !token.isEmpty {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        req.timeoutInterval = 10
        return req
    }

    /// `GET /api/health` — verifies the URL is a live dashboard (raw, not wrapped).
    public func health() async throws -> HealthStatus {
        let (data, _) = try await session.data(for: makeRequest("api/health"))
        return try JSONDecoder().decode(HealthStatus.self, from: data)
    }

    /// `GET /api/sessions` — initial session load. Handles both the
    /// `ApiResponse<[…]>` envelope and a bare array, for resilience.
    public func sessions() async throws -> [DashboardSession] {
        let (data, _) = try await session.data(for: makeRequest("api/sessions"))
        if let wrapped = try? JSONDecoder().decode(ApiResponse<[DashboardSession]>.self, from: data),
           let arr = wrapped.data {
            return arr
        }
        return try JSONDecoder().decode([DashboardSession].self, from: data)
    }
}
