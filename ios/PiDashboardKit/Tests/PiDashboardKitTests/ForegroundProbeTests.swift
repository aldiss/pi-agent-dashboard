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
        let control = ForegroundProbeControl()
        let probe = Task {
            await DashboardClient.awaitForegroundPong(
                timeout: 0.01, sleep: control.sleep, sendPing: control.sendPing
            )
        }
        await fulfillment(of: [control.pingSent, control.timeoutStarted], timeout: 5)
        XCTAssertEqual(control.state.duration, .milliseconds(10))

        control.fireTimeout()
        let alive = await probe.value
        var recoveryCount = 0
        if !alive { recoveryCount += 1 }

        XCTAssertFalse(alive, "timeoutFirstReturnsFalse")
        XCTAssertEqual(recoveryCount, 1)
        XCTAssertFalse(control.state.pending, "noPendingTimeoutAfterTimeout")
        XCTAssertFalse(control.state.cancelled, "timeoutFinishedNormally")
        XCTAssertEqual(control.state.finishes, 1, "timeoutTaskFinishedBeforeReturn")
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
        let control = ForegroundProbeControl()
        let alive = await DashboardClient.awaitForegroundPong(timeout: 10, sleep: control.sleep) { completion in
            completion(ProbeError())
            completion(nil)
        }

        XCTAssertFalse(alive)
        XCTAssertTrue(control.state.cancelled)
        XCTAssertFalse(control.state.pending)
        XCTAssertEqual(control.state.finishes, 1)
    }

    func testLatePongAfterTimeoutIsIgnored() async {
        let control = ForegroundProbeControl()
        let probe = Task {
            await DashboardClient.awaitForegroundPong(
                timeout: 0.01, sleep: control.sleep, sendPing: control.sendPing
            )
        }
        await fulfillment(of: [control.pingSent, control.timeoutStarted], timeout: 5)

        // Await the actual timeout result before delivering a late (and duplicate)
        // pong. A second continuation resume would trap, not merely change a value.
        control.fireTimeout()
        let alive = await probe.value
        XCTAssertFalse(alive, "timeoutFirstReturnsFalse")
        control.pong()
        control.pong()

        let afterLatePong = await probe.value
        XCTAssertFalse(afterLatePong, "latePongCannotReplaceTimeout")
        XCTAssertFalse(control.state.pending, "noPendingTimeoutAfterLatePong")
        XCTAssertEqual(control.state.finishes, 1, "timeoutTaskFinishedExactlyOnce")
    }

    func testPongFirstCancelsTimeoutTaskBeforeReturning() async {
        let control = ForegroundProbeControl()
        let probe = Task {
            await DashboardClient.awaitForegroundPong(
                timeout: 0.01, sleep: control.sleep, sendPing: control.sendPing
            )
        }
        await fulfillment(of: [control.pingSent, control.timeoutStarted], timeout: 5)

        control.pong()
        control.pong()
        let alive = await probe.value
        XCTAssertTrue(alive, "pongFirstReturnsTrue")
        XCTAssertTrue(control.state.cancelled, "pongFirstCancelsTimeout")
        XCTAssertFalse(control.state.pending, "noPendingTimeoutAfterPong")
        XCTAssertEqual(control.state.finishes, 1, "timeoutTaskFinishedBeforeReturn")

        // Drain any regressed pending sleep after asserting on it. Cancellation
        // also makes the timeout attempt false; neither it nor duplicate pongs
        // may resume the checked continuation again.
        control.fireTimeout()
        control.pong()
        await fulfillment(of: [control.timeoutFinished], timeout: 5)
        let afterLateCompletion = await probe.value
        XCTAssertTrue(afterLateCompletion, "firstPongStillWins")
    }

    func testImmediatePongAlsoJoinsCancelledTimeout() async {
        let control = ForegroundProbeControl()
        let alive = await DashboardClient.awaitForegroundPong(timeout: 10, sleep: control.sleep) { completion in
            // This callback runs synchronously, before the timeout Task is created.
            completion(nil)
            completion(nil)
        }

        XCTAssertTrue(alive)
        XCTAssertTrue(control.state.cancelled)
        XCTAssertFalse(control.state.pending)
        XCTAssertEqual(control.state.finishes, 1)
    }
}

private final class ForegroundProbeControl: @unchecked Sendable {
    let pingSent = XCTestExpectation(description: "ping callback registered")
    let timeoutStarted = XCTestExpectation(description: "timeout sleep entered")
    let timeoutFinished = XCTestExpectation(description: "timeout sleep exited")

    private let lock = NSLock()
    private var completion: (@Sendable (Error?) -> Void)?
    private var sleeper: CheckedContinuation<Void, any Error>?
    private var cancelled = false
    private var finishes = 0
    private var duration: Duration?

    var state: (pending: Bool, cancelled: Bool, finishes: Int, duration: Duration?) {
        lock.withLock { (sleeper != nil, cancelled, finishes, duration) }
    }

    func sendPing(_ completion: @escaping @Sendable (Error?) -> Void) {
        lock.withLock { self.completion = completion }
        pingSent.fulfill()
    }

    func pong(_ error: Error? = nil) {
        let completion = lock.withLock { self.completion }
        completion?(error)
    }

    func sleep(for duration: Duration) async throws {
        defer {
            lock.withLock { finishes += 1 }
            timeoutFinished.fulfill()
        }
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
                let alreadyCancelled = lock.withLock {
                    self.duration = duration
                    guard !cancelled else { return true }
                    sleeper = continuation
                    return false
                }
                if alreadyCancelled { continuation.resume(throwing: CancellationError()) }
                timeoutStarted.fulfill()
            }
        } onCancel: {
            self.cancel()
        }
    }

    func fireTimeout() {
        let continuation = lock.withLock {
            let continuation = sleeper
            sleeper = nil
            return continuation
        }
        continuation?.resume()
    }

    private func cancel() {
        let continuation = lock.withLock {
            cancelled = true
            let continuation = sleeper
            sleeper = nil
            return continuation
        }
        continuation?.resume(throwing: CancellationError())
    }
}
