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

    public struct ServerMetrics: Codable, Sendable {
        public let activeSessions: Int?
        public let totalSessions: Int?
        public let eventStoreSessions: Int?
    }
}
