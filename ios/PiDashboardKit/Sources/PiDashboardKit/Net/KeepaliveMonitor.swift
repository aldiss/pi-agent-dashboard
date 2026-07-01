import Foundation

/// Pure, deterministic liveness state machine for the WebSocket keepalive (DF#4).
/// The half-open-socket problem: a TCP connection can go dead (peer/NAT dropped it)
/// while `receive()` never errors — the read just hangs forever, so nothing drives a
/// reconnect and the stream silently stales. The fix is an active heartbeat: send a
/// ping on an interval, and if NO frame or pong comes back within a deadline, declare
/// the socket dead and force a reconnect.
///
/// This type owns ONLY the timing decisions — it takes `now` from the caller (never
/// reads the clock itself), so the whole ping/deadline logic is unit-testable via
/// `swift test` with no socket, no `URLSession`, no real time. `DashboardClient`
/// supplies the clock + does the actual `sendPing` / teardown.
public struct KeepaliveMonitor: Sendable, Equatable {
    /// Seconds between keepalive pings.
    public let pingInterval: TimeInterval
    /// Seconds to wait for ANY frame/pong after the last one before declaring death.
    /// A ping is sent every `pingInterval`; if the socket is live the pong (or any
    /// server frame) refreshes `lastSeen`. Death = no life for `pingInterval +
    /// pongDeadline` (one missed ping cycle plus its grace window).
    public let pongDeadline: TimeInterval

    /// Timestamp of the last inbound life signal (any frame OR a pong). Seeded to the
    /// connect time.
    public private(set) var lastSeen: TimeInterval
    /// Timestamp of the last ping we sent (seeded to connect time so the first ping
    /// waits a full interval).
    public private(set) var lastPing: TimeInterval

    /// Default cadence: ping every 22s, tolerate ~10s for the pong → dead at ~32s of
    /// silence. Well under typical NAT/idle timeouts, comfortably above jitter.
    public init(pingInterval: TimeInterval = 22, pongDeadline: TimeInterval = 10,
                startedAt: TimeInterval) {
        self.pingInterval = pingInterval
        self.pongDeadline = pongDeadline
        self.lastSeen = startedAt
        self.lastPing = startedAt
    }

    /// Record any inbound life — a decoded frame OR a pong reply. Refreshes liveness.
    public mutating func recordActivity(at now: TimeInterval) {
        if now > lastSeen { lastSeen = now }
    }

    /// Record that a ping was just sent (resets the ping cadence).
    public mutating func recordPingSent(at now: TimeInterval) {
        if now > lastPing { lastPing = now }
    }

    /// Whether a keepalive ping is due (>= `pingInterval` since the last ping).
    public func shouldPing(now: TimeInterval) -> Bool {
        now - lastPing >= pingInterval
    }

    /// Whether the socket is dead — no life signal for `pingInterval + pongDeadline`.
    /// This is the half-open detector: with a live socket, pings elicit pongs that
    /// refresh `lastSeen`; a dead half-open socket goes silent and trips this.
    public func isDead(now: TimeInterval) -> Bool {
        now - lastSeen >= pingInterval + pongDeadline
    }

    /// Seconds until the next ping is due (0 if already due) — lets the caller sleep
    /// exactly long enough instead of polling on a fixed tick.
    public func secondsUntilNextPing(now: TimeInterval) -> TimeInterval {
        max(0, (lastPing + pingInterval) - now)
    }
}
