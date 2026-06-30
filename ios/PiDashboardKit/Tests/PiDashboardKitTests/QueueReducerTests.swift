import XCTest
@testable import PiDashboardKit

/// Tests for the follow-up QUEUE reducer (send-while-streaming): optimistic enqueue,
/// `message_enqueued` confirm/append, `queue_state` authoritative atomic-replace,
/// `message_start(queueNonce)` dequeue, and `send_prompt_failed` → failed. Pure +
/// deterministic — no network/sim.
final class QueueReducerTests: XCTestCase {

    private func enqueued(_ nonce: String, _ text: String, source: String = "dashboard") -> DashboardEvent {
        DashboardEvent(eventType: "message_enqueued", timestamp: 1, data: [
            "queueNonce": .string(nonce), "text": .string(text), "source": .string(source)])
    }
    private func queueState(_ entries: [(nonce: String?, text: String, source: String)],
                            total: Int) -> DashboardEvent {
        let followUp: [JSONValue] = entries.map { e in
            var o: [String: JSONValue] = ["text": .string(e.text), "source": .string(e.source)]
            if let n = e.nonce { o["queueNonce"] = .string(n) }
            return .object(o)
        }
        return DashboardEvent(eventType: "queue_state", timestamp: 2, data: [
            "followUp": .array(followUp), "steeringCount": .number(0),
            "pendingMessageCount": .number(Double(total))])
    }
    private func userStart(_ text: String, nonce: String? = nil, _ ts: Double = 5) -> DashboardEvent {
        var data: [String: JSONValue] = ["message": .object(["role": .string("user"), "content": .string(text)])]
        if let nonce { data["queueNonce"] = .string(nonce) }
        return DashboardEvent(eventType: "message_start", timestamp: ts, data: data)
    }

    // MARK: optimistic enqueue

    func testEnqueueOptimisticCreatesPendingEntry() {
        let s = ChatSessionState().enqueueingOptimistic(text: "follow up", nonce: "n1")
        XCTAssertEqual(s.queued.count, 1)
        XCTAssertEqual(s.queued[0].status, .pending)
        XCTAssertEqual(s.queued[0].text, "follow up")
        XCTAssertEqual(s.queued[0].source, .dashboard)
        XCTAssertEqual(s.activeQueuedCount, 1)
    }

    // MARK: message_enqueued

    func testEnqueuedConfirmsMatchingDashboardOptimistic() {
        var s = ChatSessionState().enqueueingOptimistic(text: "follow up", nonce: "n1")
        s = s.reduce(enqueued("n1", "follow up"))
        XCTAssertEqual(s.queued.count, 1) // confirmed in place, not appended
        XCTAssertEqual(s.queued[0].status, .confirmed)
    }

    func testEnqueuedFromTuiAppendsNewCard() {
        var s = ChatSessionState().enqueueingOptimistic(text: "mine", nonce: "n1")
        s = s.reduce(enqueued("tuiNonce", "typed in terminal", source: "tui"))
        XCTAssertEqual(s.queued.count, 2)
        XCTAssertEqual(s.queued[1].source, .tui)
        XCTAssertEqual(s.queued[1].status, .confirmed)
        XCTAssertEqual(s.queued[0].status, .pending) // mine still pending
    }

    func testEnqueuedUnknownNonceAppendsConfirmed() {
        let s = ChatSessionState().reduce(enqueued("x9", "from elsewhere"))
        XCTAssertEqual(s.queued.count, 1)
        XCTAssertEqual(s.queued[0].status, .confirmed)
    }

    func testEnqueuedIdempotentForConfirmedNonce() {
        var s = ChatSessionState().enqueueingOptimistic(text: "a", nonce: "n1")
        s = s.reduce(enqueued("n1", "a"))
        s = s.reduce(enqueued("n1", "a")) // duplicate
        XCTAssertEqual(s.queued.count, 1)
    }

    // MARK: queue_state (authoritative atomic-replace)

    func testQueueStateAtomicReplacesConfirmedInOrder() {
        var s = ChatSessionState()
            .enqueueingOptimistic(text: "first", nonce: "n1")
            .enqueueingOptimistic(text: "second", nonce: "n2")
        s = s.reduce(enqueued("n1", "first"))
        s = s.reduce(enqueued("n2", "second"))
        // Snapshot reorders to [second, first].
        s = s.reduce(queueState([(nonce: "n2", text: "second", source: "dashboard"),
                                 (nonce: "n1", text: "first", source: "dashboard")], total: 2))
        XCTAssertEqual(s.queued.map { $0.text }, ["second", "first"])
        XCTAssertTrue(s.queued.allSatisfy { $0.status == .confirmed })
        XCTAssertEqual(s.activeQueuedCount, 2)
    }

    func testQueueStateKeepsPendingOptimisticAtTail() {
        var s = ChatSessionState()
            .enqueueingOptimistic(text: "acked", nonce: "n1")
            .enqueueingOptimistic(text: "not yet", nonce: "n2") // still pending
        s = s.reduce(enqueued("n1", "acked"))
        // Snapshot covers only n1; n2 (pending, uncovered) stays at the tail.
        s = s.reduce(queueState([(nonce: "n1", text: "acked", source: "dashboard")], total: 1))
        XCTAssertEqual(s.queued.map { $0.text }, ["acked", "not yet"])
        XCTAssertEqual(s.queued[0].status, .confirmed)
        XCTAssertEqual(s.queued[1].status, .pending)
    }

    func testQueueStateWithTuiEntries() {
        let s = ChatSessionState().reduce(
            queueState([(nonce: nil, text: "tui follow", source: "tui")], total: 1))
        XCTAssertEqual(s.queued.count, 1)
        XCTAssertEqual(s.queued[0].source, .tui)
        XCTAssertEqual(s.queued[0].status, .confirmed)
    }

    func testQueueStateEmptyClearsConfirmed() {
        var s = ChatSessionState().enqueueingOptimistic(text: "a", nonce: "n1")
        s = s.reduce(enqueued("n1", "a"))
        s = s.reduce(queueState([], total: 0))
        XCTAssertTrue(s.queued.isEmpty)
    }

    // MARK: dequeue via message_start(queueNonce)

    func testUserStartWithNonceDequeuesIntoBubble() {
        var s = ChatSessionState().enqueueingOptimistic(text: "follow up", nonce: "n1")
        s = s.reduce(enqueued("n1", "follow up"))
        XCTAssertEqual(s.queued.count, 1)
        // The bridge dispatches it: message_start(role:user, queueNonce:n1).
        s = s.reduce(userStart("follow up", nonce: "n1"))
        XCTAssertTrue(s.queued.isEmpty, "dequeued from queued[]")
        XCTAssertEqual(s.messages.filter { $0.role == .user }.count, 1, "became a committed bubble")
    }

    func testTurnInitiatingUserStartDoesNotDequeue() {
        // 0-queue degenerate: a normal turn-initiating message (no queueNonce) must
        // not touch the queue.
        var s = ChatSessionState().enqueueingOptimistic(text: "queued one", nonce: "n1")
        s = s.reduce(userStart("a brand new turn", nonce: nil))
        XCTAssertEqual(s.queued.count, 1, "queue untouched")
        XCTAssertEqual(s.messages.filter { $0.role == .user }.count, 1)
    }

    // MARK: failed

    func testMarkQueuedFailed() {
        var s = ChatSessionState().enqueueingOptimistic(text: "a", nonce: "n1")
        s = s.markingQueuedFailed(nonce: "n1")
        XCTAssertEqual(s.queued[0].status, .failed)
        XCTAssertEqual(s.activeQueuedCount, 0) // failed excluded from the badge count
    }

    func testMarkQueuedFailedUnknownNonceNoOp() {
        let s = ChatSessionState().enqueueingOptimistic(text: "a", nonce: "n1")
        XCTAssertEqual(s.markingQueuedFailed(nonce: "other"), s)
    }
}
