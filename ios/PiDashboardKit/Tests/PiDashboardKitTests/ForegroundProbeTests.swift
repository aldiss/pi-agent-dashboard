import XCTest
@testable import PiDashboardKit

final class ForegroundProbeTests: XCTestCase {
    func testProbeSuccessDoesNotRecover() async {
        let alive = await DashboardClient.awaitForegroundPong(timeout: 0.1) { completion in
            completion(nil)
        }
        var recoveryCount = 0
        if !alive { recoveryCount += 1 }

        XCTAssertTrue(alive)
        XCTAssertEqual(recoveryCount, 0)
    }

    func testProbeTimeoutRecovers() async {
        let alive = await DashboardClient.awaitForegroundPong(timeout: 0.01) { _ in }
        var recoveryCount = 0
        if !alive { recoveryCount += 1 }

        XCTAssertFalse(alive)
        XCTAssertEqual(recoveryCount, 1)
    }

    func testProbeTimeoutIsWellBelowPassiveDeadline() {
        let keepalive = KeepaliveMonitor(startedAt: 0)
        XCTAssertEqual(DashboardClient.foregroundProbeTimeout, 2)
        XCTAssertLessThan(
            DashboardClient.foregroundProbeTimeout,
            keepalive.pingInterval + keepalive.pongDeadline
        )
    }

    func testProbeErrorRecoversWithoutWaitingForTimeout() async {
        struct ProbeError: Error {}
        let alive = await DashboardClient.awaitForegroundPong(timeout: 10) { completion in
            completion(ProbeError())
        }

        XCTAssertFalse(alive)
    }

    func testLatePongAfterTimeoutIsIgnored() async {
        let alive = await DashboardClient.awaitForegroundPong(timeout: 0.01) { completion in
            Task {
                try? await Task.sleep(for: .milliseconds(50))
                completion(nil)
            }
        }

        XCTAssertFalse(alive)
        try? await Task.sleep(for: .milliseconds(60))
    }
}
