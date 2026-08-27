import XCTest
@testable import PiDashboardKit

/// Delivery-truth contract. An optimistic user bubble (`optim-<nonce>`, `.pending`)
/// is confirmed only by an application-level echo — never by elapsed time after a
/// local WebSocket write. A no-ack deadline marks the exact row failed; a late genuine
/// echo recovers it in place. Pure — `swift test`, no simulator.
final class StuckSendingTests: XCTestCase {

    /// A user `message_start` echo carrying a `queueNonce` (the live dispatch shape).
    private func userEchoWithNonce(_ text: String, nonce: String, ts: Double = 200) -> DashboardEvent {
        DashboardEvent(eventType: "message_start", timestamp: ts,
                       data: ["message": .object(["role": .string("user"), "content": .string(text)]),
                              "queueNonce": .string(nonce)])
    }

    // MARK: confirm-by-nonce (primary path)

    /// The matching-nonce echo confirms the exact `optim-<nonce>` bubble (clears
    /// "Sending…") without appending a duplicate — even though the text also matches.
    func testMatchingNonceConfirmsTheBubble() {
        var s = ChatSessionState().appendingOptimisticUser(
            text: "deploy the thing", timestamp: 1, nonce: "n1")
        XCTAssertTrue(s.hasPendingOptimisticUser)
        s = s.reduce(userEchoWithNonce("deploy the thing", nonce: "n1", ts: 200))
        XCTAssertEqual(s.messages.filter { $0.role == .user }.count, 1, "no duplicate row")
        XCTAssertEqual(s.messages[0].delivery, .confirmed)
        XCTAssertEqual(s.messages[0].timestamp, 200, "adopts the server timestamp")
        XCTAssertFalse(s.hasPendingOptimisticUser, "no longer stuck Sending…")
    }

    /// Confirm-by-nonce works even when the echoed TEXT differs from the optimistic
    /// text (whitespace / skill-envelope drift — the real stuck-Sending trigger the
    /// text-match couldn't handle).
    func testNonceConfirmsDespiteTextDrift() {
        var s = ChatSessionState().appendingOptimisticUser(
            text: "/deploy prod", timestamp: 1, nonce: "n1")
        // Server echoes a wrapped/normalized form the text-match would MISS.
        s = s.reduce(userEchoWithNonce("<skill>deploy</skill> prod", nonce: "n1", ts: 5))
        XCTAssertEqual(s.messages.filter { $0.role == .user }.count, 1)
        XCTAssertEqual(s.messages[0].delivery, .confirmed, "nonce match beats text drift")
    }

    /// A NON-matching nonce does NOT confirm the bubble via the nonce path. (Here the
    /// text also differs, so the fallback appends a fresh row — the bubble stays
    /// pending, correctly awaiting its own echo.)
    func testNonMatchingNonceDoesNotConfirm() {
        var s = ChatSessionState().appendingOptimisticUser(
            text: "first", timestamp: 1, nonce: "n1")
        s = s.reduce(userEchoWithNonce("second", nonce: "OTHER", ts: 5))
        let pending = s.messages.first { $0.id == "optim-n1" }
        XCTAssertEqual(pending?.delivery, .pending, "wrong-nonce echo must not confirm this bubble")
        XCTAssertEqual(s.messages.filter { $0.role == .user }.count, 2)
    }

    /// TWO identical-text pending sends: the matching-nonce echo confirms the RIGHT
    /// bubble by nonce (n2), leaving n1 still pending — the exact ambiguity the
    /// text-match got wrong.
    func testTwoIdenticalTextConfirmRightBubbleByNonce() {
        var s = ChatSessionState()
            .appendingOptimisticUser(text: "same text", timestamp: 1, nonce: "n1")
            .appendingOptimisticUser(text: "same text", timestamp: 2, nonce: "n2")
        s = s.reduce(userEchoWithNonce("same text", nonce: "n2", ts: 10))
        let b1 = s.messages.first { $0.id == "optim-n1" }
        let b2 = s.messages.first { $0.id == "optim-n2" }
        XCTAssertEqual(b2?.delivery, .confirmed, "n2 confirmed by its nonce")
        XCTAssertEqual(b1?.delivery, .pending, "n1 untouched — not grabbed by text")
        XCTAssertEqual(s.messages.filter { $0.role == .user }.count, 2, "no duplicate rows")
    }

    // MARK: text-match fallback still intact (no nonce on the echo)

    /// When the echo carries NO queueNonce, the trimmed-text fallback still confirms
    /// the pending bubble (back-compat with older servers / TUI-origin echoes).
    func testTextMatchFallbackWhenNoNonce() {
        var s = ChatSessionState().appendingOptimisticUser(
            text: "hello world", timestamp: 1, nonce: "n1")
        let noNonceEcho = DashboardEvent(
            eventType: "message_start", timestamp: 2,
            data: ["message": .object(["role": .string("user"), "content": .string("hello world")])])
        s = s.reduce(noNonceEcho)
        XCTAssertEqual(s.messages.filter { $0.role == .user }.count, 1)
        XCTAssertEqual(s.messages[0].delivery, .confirmed, "text-match fallback still works")
    }

    // MARK: no-ack deadline

    /// A send with no application-level acknowledgement becomes failed, never
    /// falsely confirmed merely because bytes entered the local socket buffer.
    func testNoAckMarksExactPendingBubbleFailed() {
        var s = ChatSessionState()
            .appendingOptimisticUser(text: "first", timestamp: 1, nonce: "n1")
            .appendingOptimisticUser(text: "second", timestamp: 2, nonce: "n2")
        s = s.markingOptimisticFailed(nonce: "n1")
        XCTAssertEqual(s.messages.first { $0.id == "optim-n1" }?.delivery, .failed)
        XCTAssertEqual(s.messages.first { $0.id == "optim-n2" }?.delivery, .pending,
                       "deadline must not fail a different send")
    }

    /// Confirmed/unknown rows are immutable under the failure deadline.
    func testNoAckFailureIsIdempotentAndScoped() {
        var confirmed = ChatSessionState().appendingOptimisticUser(
            text: "x", timestamp: 1, nonce: "n1")
        confirmed = confirmed.reduce(userEchoWithNonce("x", nonce: "n1"))
        XCTAssertEqual(confirmed.markingOptimisticFailed(nonce: "n1"), confirmed)
        XCTAssertEqual(confirmed.markingOptimisticFailed(nonce: "absent"), confirmed)
    }

    func testConnectionDropFailsAllPendingLocalSendsButNotConfirmedOnes() {
        var state = ChatSessionState()
            .appendingOptimisticUser(text: "idle", timestamp: 1, nonce: "m1")
            .enqueueingOptimistic(text: "queued", nonce: "q1")
        state.queued.append(QueuedMessage(
            queueNonce: "q2", text: "already accepted", status: .confirmed))

        state = state.failingPendingLocalSends()
        XCTAssertEqual(state.messages[0].delivery, .failed)
        XCTAssertEqual(state.queued.first { $0.queueNonce == "q1" }?.status, .failed)
        XCTAssertEqual(state.queued.first { $0.queueNonce == "q2" }?.status, .confirmed)
    }

    /// A real echo arriving after the no-ack deadline recovers the failed row in
    /// place; it must not append a second copy of the operator's message.
    func testLateAcknowledgementRecoversFailedBubble() {
        var s = ChatSessionState()
            .appendingOptimisticUser(text: "late", timestamp: 1, nonce: "n1")
            .markingOptimisticFailed(nonce: "n1")
        s = s.reduce(userEchoWithNonce("late", nonce: "n1", ts: 50))
        XCTAssertEqual(s.messages.count, 1)
        XCTAssertEqual(s.messages[0].delivery, .confirmed)
        XCTAssertEqual(s.messages[0].timestamp, 50)
    }
}
