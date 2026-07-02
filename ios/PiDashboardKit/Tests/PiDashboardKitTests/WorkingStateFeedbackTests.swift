import XCTest
@testable import PiDashboardKit

/// Round 3.2 — working-state feedback: a long turn must VISIBLY look alive, not hung.
/// Pins the reducer half of the fix: the agent-run elapsed anchor (`streamingStartedAt`)
/// lifecycle, and the pure `streamingIndicator` resolver the view switches on (live
/// reasoning surfaces when there's no committed text; the timer + tool line follow).
final class WorkingStateFeedbackTests: XCTestCase {

    private func evt(_ type: String, _ ts: Double = 0, _ data: [String: JSONValue] = [:]) -> DashboardEvent {
        DashboardEvent(eventType: type, timestamp: ts, data: data)
    }
    private func thinkingDelta(_ delta: String, _ ts: Double = 0) -> DashboardEvent {
        evt("message_update", ts, ["assistantMessageEvent": .object([
            "type": .string("thinking_delta"), "delta": .string(delta)])])
    }
    private func thinkingStart(_ ts: Double = 0) -> DashboardEvent {
        evt("message_update", ts, ["assistantMessageEvent": .object(["type": .string("thinking_start")])])
    }

    // MARK: streamingStartedAt lifecycle (the elapsed anchor)

    func testAgentStartAnchorsTimerAgentEndClearsIt() {
        var s = ChatSessionState()
        XCTAssertNil(s.streamingStartedAt)
        s = s.reduce(evt("agent_start", 1000))
        XCTAssertEqual(s.streamingStartedAt, 1000, "agent_start anchors the elapsed timer")
        XCTAssertTrue(s.isStreaming)
        // ... a long turn of thinking/tool events does NOT move the anchor ...
        s = s.reduce(thinkingStart(2000)).reduce(thinkingDelta("pondering", 2500))
        XCTAssertEqual(s.streamingStartedAt, 1000, "anchor is turn-level, unchanged by thinking")
        s = s.reduce(evt("agent_end", 9999))
        XCTAssertNil(s.streamingStartedAt, "agent_end clears the anchor → indicator hides")
        XCTAssertFalse(s.isStreaming)
    }

    /// Defensive: a replay that begins mid-run (isStreaming already true, anchor unset)
    /// anchors on the next turn_start so the timer still ticks.
    func testTurnStartAnchorsWhenStreamingButUnset() {
        var s = ChatSessionState()
        s.isStreaming = true // simulate mid-run replay with no prior agent_start folded
        s = s.reduce(evt("turn_start", 4200))
        XCTAssertEqual(s.streamingStartedAt, 4200)
    }

    func testTurnStartDoesNotAnchorWhenNotStreaming() {
        var s = ChatSessionState()
        s = s.reduce(evt("turn_start", 4200))
        XCTAssertNil(s.streamingStartedAt, "no anchor when not streaming")
    }

    func testTurnStartDoesNotOverrideExistingAnchor() {
        var s = ChatSessionState().reduce(evt("agent_start", 1000))
        s = s.reduce(evt("turn_start", 5000))
        XCTAssertEqual(s.streamingStartedAt, 1000, "existing anchor preserved across turn_start")
    }

    // MARK: streamingIndicator resolver (what the view renders)

    func testIndicatorHiddenWhenNotStreaming() {
        XCTAssertEqual(ChatSessionState().streamingIndicator, .hidden)
    }

    func testIndicatorTextWinsWhenStreamingTextPresent() {
        var s = ChatSessionState()
        s.isStreaming = true
        s.streamingText = "the answer is arriving"
        s.streamingThinking = "still reasoning"   // text takes priority
        s.currentTool = "bash"
        XCTAssertEqual(s.streamingIndicator, .text)
    }

    func testIndicatorToolWhenToolRunningNoText() {
        var s = ChatSessionState()
        s.isStreaming = true
        s.currentTool = "bash"
        s.streamingThinking = "reasoning"   // tool outranks thinking
        XCTAssertEqual(s.streamingIndicator, .tool("bash"))
    }

    /// THE FIX: streamingThinking surfaces in the indicator when streamingText is empty
    /// and no tool is running — the operator SEES reasoning move instead of a bare spinner.
    func testIndicatorThinkingSurfacesWhenTextEmptyNoTool() {
        var s = ChatSessionState()
        s.isStreaming = true
        s.streamingThinking = "Let me work through this step by step…"
        XCTAssertEqual(s.streamingIndicator, .thinking("Let me work through this step by step…"))
    }

    func testIndicatorWaitingWhenNothingSurfacedYet() {
        var s = ChatSessionState()
        s.isStreaming = true // no text, no tool, no thinking
        XCTAssertEqual(s.streamingIndicator, .waiting)
    }

    /// Whitespace-only thinking is not "reasoning shown" → falls through to waiting.
    func testIndicatorWhitespaceThinkingIsWaiting() {
        var s = ChatSessionState()
        s.isStreaming = true
        s.streamingThinking = "   \n  "
        XCTAssertEqual(s.streamingIndicator, .waiting)
    }

    /// End-to-end via real events: a thinking stream with no committed text resolves to
    /// `.thinking` and carries the accumulated reasoning.
    func testIndicatorThinkingFromReducedEventStream() {
        let s = ChatSessionState()
            .reduce(evt("agent_start", 1000))
            .reduce(thinkingStart(1100))
            .reduce(thinkingDelta("First, ", 1200))
            .reduce(thinkingDelta("then next.", 1300))
        XCTAssertEqual(s.streamingIndicator, .thinking("First, then next."))
        XCTAssertEqual(s.streamingStartedAt, 1000)
    }
}
