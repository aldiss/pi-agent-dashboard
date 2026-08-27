import XCTest
@testable import PiDashboardKit

/// Authoritative replay replaces server-owned history but must not erase local
/// intent the server may not have acknowledged yet.
final class ReplayResetIntentTests: XCTestCase {
    func testResetPreservesPendingAndFailedOptimisticRowsOnly() {
        var state = ChatSessionState()
        state.messages = [
            ChatMessage(id: "server-1", role: .assistant, content: "history", timestamp: 1),
            ChatMessage(id: "optim-p", role: .user, content: "pending", timestamp: 2,
                        delivery: .pending),
            ChatMessage(id: "optim-f", role: .user, content: "failed", timestamp: 3,
                        delivery: .failed),
            ChatMessage(id: "optim-c", role: .user, content: "confirmed", timestamp: 4,
                        delivery: .confirmed),
        ]

        let reset = state.resetPreservingLocalIntent()
        XCTAssertEqual(reset.messages.map(\.id), ["optim-p", "optim-f"])
        XCTAssertTrue(reset.toolCalls.isEmpty)
        XCTAssertEqual(reset.streamingText, "")
        XCTAssertFalse(reset.isStreaming)
    }

    func testResetPreservesWholeFollowUpQueue() {
        var state = ChatSessionState()
        state.queued = [
            QueuedMessage(queueNonce: "p", text: "pending", status: .pending),
            QueuedMessage(queueNonce: "c", text: "confirmed", status: .confirmed),
            QueuedMessage(queueNonce: "f", text: "failed", status: .failed),
        ]
        XCTAssertEqual(state.resetPreservingLocalIntent().queued, state.queued)
    }

    func testReplayedWrappedEchoRecoversPreservedFailedRow() {
        let body = "hello"
        let wrapped = "<speaker nonce=\"secret\">\nhello\n</speaker nonce=\"secret\">"
        var state = ChatSessionState()
            .appendingOptimisticUser(text: body, timestamp: 1, nonce: "n1")
            .markingOptimisticFailed(nonce: "n1")
            .resetPreservingLocalIntent()

        state = state.reduce(DashboardEvent(
            eventType: "message_start", timestamp: 2,
            data: ["message": .object(["role": .string("user"), "content": .string(wrapped)])]))

        XCTAssertEqual(state.messages.count, 1)
        XCTAssertEqual(state.messages[0].delivery, .confirmed)
        XCTAssertEqual(state.messages[0].content, body)
    }
}
