import XCTest
@testable import PiDashboardKit

/// DF#5 perf — the pure render-window + payload-truncation logic that keeps a large
/// session (hundreds/thousands of rows, giant tool/bash outputs) loading fast. Pure,
/// `swift test`-verified, no SwiftUI / no simulator.
final class ChatWindowTests: XCTestCase {

    private func msgs(_ n: Int) -> [ChatMessage] {
        (0..<n).map { ChatMessage(id: "m\($0)", role: .assistant, content: "row \($0)", timestamp: Double($0)) }
    }

    // MARK: windowing (the biggest render lever)

    /// A session larger than the limit renders only the most-recent `limit` rows and
    /// reports how many were clipped from the head.
    func testWindowClipsToTailWithHiddenCount() {
        let w = ChatWindow.window(msgs(1000), limit: 175)
        XCTAssertEqual(w.rows.count, 175, "renders only the tail window")
        XCTAssertEqual(w.hiddenCount, 825, "reports clipped older rows")
        XCTAssertEqual(w.rows.first?.id, "m825", "window is the MOST-RECENT 175")
        XCTAssertEqual(w.rows.last?.id, "m999", "newest row present")
    }

    /// Order + identity are preserved within the window (LazyVStack stable ids).
    func testWindowPreservesOrderAndIdentity() {
        let w = ChatWindow.window(msgs(200), limit: 50)
        XCTAssertEqual(w.rows.map(\.id), (150..<200).map { "m\($0)" })
    }

    /// Sessions at/under the limit render fully — no clipping, hiddenCount 0.
    func testWindowUnderLimitReturnsAll() {
        XCTAssertEqual(ChatWindow.window(msgs(175), limit: 175).hiddenCount, 0)
        let small = ChatWindow.window(msgs(10), limit: 175)
        XCTAssertEqual(small.rows.count, 10)
        XCTAssertEqual(small.hiddenCount, 0)
    }

    /// `showAll` (operator tapped "Load earlier") reveals the whole transcript.
    func testWindowShowAllReturnsEverything() {
        let w = ChatWindow.window(msgs(1000), limit: 175, showAll: true)
        XCTAssertEqual(w.rows.count, 1000)
        XCTAssertEqual(w.hiddenCount, 0)
    }

    func testWindowEmptyAndZeroLimitSafe() {
        XCTAssertEqual(ChatWindow.window([], limit: 175).rows.count, 0)
        XCTAssertEqual(ChatWindow.window(msgs(5), limit: 0).rows.count, 5, "limit<=0 → all")
    }

    // MARK: viewport follow + read policy

    func testViewportAtBottomAllowsFollowAndMarkRead() {
        let decision = ChatViewportPolicy.decide(bottomDistance: 0)

        XCTAssertTrue(decision.shouldAutoFollow, "genuine bottom still follows new messages")
        XCTAssertTrue(decision.shouldMarkRead, "genuine bottom marks the newest row read")
    }

    func testViewportScrolledUpDisablesFollowAndMarkRead() {
        let decision = ChatViewportPolicy.decide(bottomDistance: 320)

        XCTAssertFalse(decision.shouldAutoFollow)
        XCTAssertFalse(decision.shouldMarkRead)
    }

    func testViewportWithoutMeasurementDisablesFollowAndMarkRead() {
        let decision = ChatViewportPolicy.decide(bottomDistance: nil)

        XCTAssertFalse(decision.shouldAutoFollow, "a de-realized sentinel must not yank scrollback")
        XCTAssertFalse(decision.shouldMarkRead, "unseen rows must remain unread")
    }

    func testViewportResumesFollowingWhenMeasurementReturnsAtBottom() {
        let absent = ChatViewportPolicy.decide(bottomDistance: nil)
        let restored = ChatViewportPolicy.decide(bottomDistance: 0)

        XCTAssertFalse(absent.shouldAutoFollow)
        XCTAssertFalse(absent.shouldMarkRead)
        XCTAssertTrue(restored.shouldAutoFollow)
        XCTAssertTrue(restored.shouldMarkRead)
    }

    // MARK: payload truncation (line AND char caps)

    func testTruncateByLines() {
        let text = (0..<1000).map { "line \($0)" }.joined(separator: "\n")
        let out = ChatSessionState.truncateForDisplay(text, maxLines: 400, maxChars: 1_000_000)
        XCTAssertTrue(out.contains("truncated"), "marker appended")
        XCTAssertLessThanOrEqual(out.split(separator: "\n").count, 401, "clipped to ~maxLines + marker")
        XCTAssertTrue(out.hasPrefix("line 0"))
    }

    /// A single pathological megabyte-long line the LINE cap would miss is caught by
    /// the CHAR cap (the memory/render bloat guard).
    func testTruncateBySingleHugeLine() {
        let huge = String(repeating: "x", count: 200_000) // one 200k-char line
        let out = ChatSessionState.truncateForDisplay(huge, maxLines: 400, maxChars: 40_000)
        XCTAssertTrue(out.contains("truncated"))
        XCTAssertLessThan(out.count, 41_000, "char-capped well under the input")
    }

    /// Ordinary content under both caps is returned unchanged (no marker).
    func testTruncateNoOpUnderCaps() {
        let text = "a small\nresult\nblock"
        XCTAssertEqual(ChatSessionState.truncateForDisplay(text, maxLines: 400, maxChars: 40_000), text)
        XCTAssertEqual(ChatSessionState.truncateForDisplay("", maxLines: 400, maxChars: 40_000), "")
    }

    // MARK: reducer applies the cap (bash / raw)

    /// A giant bash_output is stored truncated (never the full megabyte payload).
    func testReducerTruncatesBashOutput() {
        let big = String(repeating: "log line\n", count: 5000) // 5000 lines
        let ev = DashboardEvent(eventType: "bash_output", timestamp: 1,
                                data: ["output": .string(big), "command": .string("run")])
        let state = ChatSessionState().reduce(ev)
        let row = state.messages.first { $0.role == .bashOutput }
        XCTAssertNotNil(row)
        XCTAssertTrue(row!.content.contains("truncated"), "huge bash output is capped in the reducer")
        XCTAssertLessThan(row!.content.count, big.count, "stored content is smaller than the raw payload")
    }

    /// An unknown (raw) event with a huge payload is capped too.
    func testReducerTruncatesRawEvent() {
        let bigVal = String(repeating: "z", count: 100_000)
        let ev = DashboardEvent(eventType: "some_unknown_event", timestamp: 1,
                                data: ["blob": .string(bigVal)])
        let state = ChatSessionState().reduce(ev)
        let row = state.messages.first { $0.role == .rawEvent }
        XCTAssertNotNil(row)
        XCTAssertTrue(row!.content.contains("truncated"))
        XCTAssertLessThan(row!.content.count, bigVal.count)
    }
}
