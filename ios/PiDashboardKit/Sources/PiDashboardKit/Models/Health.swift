import Foundation

/// Shape of `GET /api/health`. Returned raw (NOT wrapped in `ApiResponse`).
/// Used by the Connect screen to verify a server URL is a live dashboard.
public struct HealthStatus: Codable, Sendable {
    public let ok: Bool
    public let version: String?
    public let mode: String?
    public let uptime: Double?
    public let starter: String?
    public let pid: Int?
    public let server: ServerMetrics?

    public init(ok: Bool, version: String? = nil, mode: String? = nil, uptime: Double? = nil,
                starter: String? = nil, pid: Int? = nil, server: ServerMetrics? = nil) {
        self.ok = ok; self.version = version; self.mode = mode; self.uptime = uptime
        self.starter = starter; self.pid = pid; self.server = server
    }

    public struct ServerMetrics: Codable, Sendable {
        public let activeSessions: Int?
        public let totalSessions: Int?
        public let eventStoreSessions: Int?

        public init(activeSessions: Int? = nil, totalSessions: Int? = nil, eventStoreSessions: Int? = nil) {
            self.activeSessions = activeSessions
            self.totalSessions = totalSessions
            self.eventStoreSessions = eventStoreSessions
        }
    }
}
