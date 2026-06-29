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

    /// Map a dashboard base URL (`http(s)://host:port`) to its WS form (`ws(s)://…`).
    public static func websocketURL(base: URL) -> URL? {
        guard var comps = URLComponents(url: base, resolvingAgainstBaseURL: false) else { return nil }
        switch comps.scheme {
        case "https": comps.scheme = "wss"
        case "http": comps.scheme = "ws"
        case "ws", "wss": break
        default: comps.scheme = "ws"
        }
        return comps.url
    }

    /// Connect to the browser gateway and return a stream of decoded server messages.
    /// Re-connecting first tears down any existing socket.
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
        state = .connected
        Task { await self.receiveLoop() }
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

    private func receiveLoop() async {
        guard let task else { return }
        while true {
            do {
                let message = try await task.receive()
                switch message {
                case .string(let text): emit(Data(text.utf8))
                case .data(let data): emit(data)
                @unknown default: break
                }
            } catch {
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
