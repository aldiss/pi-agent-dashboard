import XCTest
@testable import PiDashboardKit

/// DF#4 — the pure keepalive liveness state machine driving half-open-socket
/// detection. Deterministic: the caller supplies `now`, so ping cadence + the
/// pong-deadline death rule are verified with no socket / no real time.
final class KeepaliveMonitorTests: XCTestCase {

    private func monitor(ping: TimeInterval = 22, deadline: TimeInterval = 10,
                         start: TimeInterval = 0) -> KeepaliveMonitor {
        KeepaliveMonitor(pingInterval: ping, pongDeadline: deadline, startedAt: start)
    }

    // MARK: ping cadence

    func testShouldPingFiresAtInterval() {
        let m = monitor(ping: 22, start: 0)
        XCTAssertFalse(m.shouldPing(now: 10), "too soon")
        XCTAssertFalse(m.shouldPing(now: 21.9))
        XCTAssertTrue(m.shouldPing(now: 22), "due at exactly the interval")
        XCTAssertTrue(m.shouldPing(now: 30))
    }

    func testRecordPingSentResetsCadence() {
        var m = monitor(ping: 22, start: 0)
        XCTAssertTrue(m.shouldPing(now: 22))
        m.recordPingSent(at: 22)
        XCTAssertFalse(m.shouldPing(now: 30), "next ping not due until 44")
        XCTAssertTrue(m.shouldPing(now: 44))
    }

    func testSecondsUntilNextPing() {
        let m = monitor(ping: 22, start: 0)
        XCTAssertEqual(m.secondsUntilNextPing(now: 0), 22, accuracy: 0.001)
        XCTAssertEqual(m.secondsUntilNextPing(now: 20), 2, accuracy: 0.001)
        XCTAssertEqual(m.secondsUntilNextPing(now: 25), 0, accuracy: 0.001, "already due → 0")
    }

    // MARK: liveness / death (the half-open detector)

    func testFreshMonitorNotDead() {
        let m = monitor(ping: 22, deadline: 10, start: 0)
        XCTAssertFalse(m.isDead(now: 0))
        XCTAssertFalse(m.isDead(now: 31.9), "just under ping+deadline")
    }

    func testDeadAfterPingPlusDeadlineOfSilence() {
        let m = monitor(ping: 22, deadline: 10, start: 0)
        // No activity since start → dead at 22 + 10 = 32s.
        XCTAssertTrue(m.isDead(now: 32), "no life for ping+deadline → dead")
        XCTAssertTrue(m.isDead(now: 60))
    }

    /// A pong (or any inbound frame) refreshes liveness so the socket is NOT dead.
    func testActivityRefreshesLiveness() {
        var m = monitor(ping: 22, deadline: 10, start: 0)
        // At 30s a pong arrives — resets lastSeen.
        m.recordActivity(at: 30)
        XCTAssertFalse(m.isDead(now: 32), "pong at 30 kept it alive past the old deadline")
        XCTAssertFalse(m.isDead(now: 61.9))
        XCTAssertTrue(m.isDead(now: 62), "…but dead again 32s after the last pong")
    }

    /// A received data frame counts as liveness exactly like a pong (the server
    /// streaming events keeps the socket alive without needing pongs).
    func testReceivedFrameCountsAsLiveness() {
        var m = monitor(ping: 22, deadline: 10, start: 0)
        m.recordActivity(at: 20) // a decoded ServerMessage arrived
        m.recordActivity(at: 40)
        m.recordActivity(at: 60)
        XCTAssertFalse(m.isDead(now: 70), "steady frames keep it alive")
    }

    /// Ping sent but NO pong/frame within the deadline → dead (the half-open case:
    /// we pinged, nothing came back).
    func testPingWithoutPongTripsDeath() {
        var m = monitor(ping: 22, deadline: 10, start: 0)
        m.recordPingSent(at: 22) // pinged at 22, but no pong ever comes
        // lastSeen is still 0 → dead at 32 (ping+deadline since last life).
        XCTAssertTrue(m.isDead(now: 32), "pinged, no pong → declared dead")
    }

    /// recordActivity/recordPingSent never move timestamps backwards (out-of-order
    /// callbacks can't corrupt the state).
    func testStampsAreMonotonic() {
        var m = monitor(start: 100)
        m.recordActivity(at: 50)  // older than start — ignored
        XCTAssertFalse(m.isDead(now: 100), "stale activity didn't rewind lastSeen")
        m.recordPingSent(at: 50)  // older than start — ignored
        XCTAssertTrue(m.shouldPing(now: 122), "ping cadence still measured from 100")
    }
}
