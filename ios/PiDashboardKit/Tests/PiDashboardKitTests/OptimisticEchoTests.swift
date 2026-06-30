import XCTest
@testable import PiDashboardKit

/// Tests for the optimistic user-echo + dedup contract: a dashboard-sent prompt is
/// rendered immediately (pending) and the server's `message_start(role:user)` echo
/// CONFIRMS it in place rather than appending a duplicate bubble.
final class OptimisticEchoTests: XCTestCase {

    private func userEcho(_ text: String, _ ts: Double = 100) -> DashboardEvent {
        DashboardEvent(eventType: "message_start", timestamp: ts,
                       data: ["message": .object(["role": .string("user"), "content": .string(text)])])
    }

    func testOptimisticAppendShowsPendingUserBubbleImmediately() {
        let s = ChatSessionState().appendingOptimisticUser(
            text: "ping the server", timestamp: 1, nonce: "n1")
        XCTAssertEqual(s.messages.count, 1)
        XCTAssertEqual(s.messages[0].role, .user)
        XCTAssertEqual(s.messages[0].content, "ping the server")
        XCTAssertEqual(s.messages[0].delivery, .pending)
        XCTAssertTrue(s.hasPendingOptimisticUser)
    }

    func testEchoConfirmsPendingInsteadOfDuplicating() {
        var s = ChatSessionState().appendingOptimisticUser(
            text: "ping the server", timestamp: 1, nonce: "n1")
        s = s.reduce(userEcho("ping the server", 200))
        // Still ONE user bubble — confirmed, not duplicated.
        XCTAssertEqual(s.messages.filter { $0.role == .user }.count, 1)
        XCTAssertEqual(s.messages[0].delivery, .confirmed)
        XCTAssertEqual(s.messages[0].timestamp, 200) // adopts server timestamp
        XCTAssertFalse(s.hasPendingOptimisticUser)
    }

    func testEchoMatchesIgnoringSurroundingWhitespace() {
        var s = ChatSessionState().appendingOptimisticUser(
            text: "hello world", timestamp: 1, nonce: "n1")
        s = s.reduce(userEcho("  hello world  ", 2)) // server may pad
        XCTAssertEqual(s.messages.filter { $0.role == .user }.count, 1)
        XCTAssertEqual(s.messages[0].delivery, .confirmed)
    }

    func testNonMatchingUserEchoAppendsNormally() {
        var s = ChatSessionState().appendingOptimisticUser(
            text: "first message", timestamp: 1, nonce: "n1")
        s = s.reduce(userEcho("a different message", 2))
        // Two distinct user rows: the pending one + the new server-originated one.
        XCTAssertEqual(s.messages.filter { $0.role == .user }.count, 2)
        XCTAssertEqual(s.messages[0].delivery, .pending) // unmatched, still pending
        XCTAssertNil(s.messages[1].delivery)             // normal server row
    }

    func testServerOriginatedUserMessageHasNoDeliveryBadge() {
        // No optimistic row present → a plain TUI-origin user message renders normally.
        let s = ChatSessionState().reduce(userEcho("typed in the terminal", 5))
        XCTAssertEqual(s.messages.count, 1)
        XCTAssertNil(s.messages[0].delivery)
    }

    func testTwoIdenticalOptimisticsPairOneToOneWithEchoes() {
        // Operator sends the same text twice; two echoes confirm both (most-recent
        // pending matched first), leaving no duplicates and no stuck pending.
        var s = ChatSessionState()
            .appendingOptimisticUser(text: "same", timestamp: 1, nonce: "n1")
            .appendingOptimisticUser(text: "same", timestamp: 2, nonce: "n2")
        XCTAssertEqual(s.messages.filter { $0.delivery == .pending }.count, 2)
        s = s.reduce(userEcho("same", 10))
        s = s.reduce(userEcho("same", 11))
        XCTAssertEqual(s.messages.filter { $0.role == .user }.count, 2)
        XCTAssertTrue(s.messages.allSatisfy { $0.delivery == .confirmed })
    }

    func testMarkLatestOptimisticFailed() {
        var s = ChatSessionState().appendingOptimisticUser(
            text: "ping", timestamp: 1, nonce: "n1")
        s = s.markingLatestOptimisticFailed()
        XCTAssertEqual(s.messages[0].delivery, .failed)
        XCTAssertFalse(s.hasPendingOptimisticUser)
    }

    func testMarkFailedNoOpWhenNoPending() {
        let s = ChatSessionState().reduce(userEcho("server msg", 1))
        let after = s.markingLatestOptimisticFailed()
        XCTAssertEqual(after, s) // unchanged — nothing pending to fail
    }

    func testFailedBubbleIsNotConfirmedByLateEcho() {
        // Once failed, a late echo of the same text appends a fresh normal row
        // rather than resurrecting the failed bubble (dedup only matches `pending`).
        var s = ChatSessionState()
            .appendingOptimisticUser(text: "ping", timestamp: 1, nonce: "n1")
            .markingLatestOptimisticFailed()
        s = s.reduce(userEcho("ping", 5))
        XCTAssertEqual(s.messages.filter { $0.role == .user }.count, 2)
        XCTAssertEqual(s.messages[0].delivery, .failed)
        XCTAssertNil(s.messages[1].delivery)
    }
}
