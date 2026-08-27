import XCTest
@testable import PiDashboardKit

/// Unit tests for the chat event reducer — the native port of `event-reducer.ts`.
/// Covers the MVP-rendered transitions: user/assistant text, thinking blocks, the
/// tool call lifecycle, the streaming-text-flush ordering, turn-stat accumulation,
/// subagents, and the unknown-event raw fallback. Pure `swift test` (no simulator).
final class EventReducerTests: XCTestCase {

    private func ev(_ type: String, _ data: [String: JSONValue] = [:], _ ts: Double = 1) -> DashboardEvent {
        DashboardEvent(eventType: type, timestamp: ts, data: data)
    }

    private func userMessage(_ text: String) -> DashboardEvent {
        ev("message_start", ["message": .object(["role": .string("user"), "content": .string(text)])])
    }

    func testUserMessagePushesRow() {
        let s = ChatSessionState().reduce(userMessage("hello world"))
        XCTAssertEqual(s.messages.count, 1)
        XCTAssertEqual(s.messages[0].role, .user)
        XCTAssertEqual(s.messages[0].content, "hello world")
    }

    func testUserMessageExtractsContentBlocksAndImages() {
        let content: JSONValue = .array([
            .object(["type": .string("text"), "text": .string("look: ")]),
            .object(["type": .string("image"), "data": .string("AAAA"), "mimeType": .string("image/png")]),
        ])
        let s = ChatSessionState().reduce(
            ev("message_start", ["message": .object(["role": .string("user"), "content": content])]))
        XCTAssertEqual(s.messages[0].content, "look: ")
        XCTAssertEqual(s.messages[0].images.count, 1)
        XCTAssertEqual(s.messages[0].images.first?.mimeType, "image/png")
    }

    func testAssistantStreamingTextFlushedAtMessageEnd() {
        var s = ChatSessionState()
        s = s.reduce(ev("agent_start"))
        s = s.reduce(ev("message_start", ["message": .object(["role": .string("assistant")])]))
        s = s.reduce(ev("message_update", ["message": .object([
            "role": .string("assistant"),
            "content": .array([.object(["type": .string("text"), "text": .string("partial answer")])]),
        ])]))
        XCTAssertEqual(s.streamingText, "partial answer")
        XCTAssertTrue(s.messages.isEmpty) // not yet committed
        s = s.reduce(ev("message_end", ["message": .object(["role": .string("assistant")])]))
        XCTAssertEqual(s.messages.count, 1)
        XCTAssertEqual(s.messages[0].role, .assistant)
        XCTAssertEqual(s.messages[0].content, "partial answer")
        XCTAssertEqual(s.streamingText, "")
    }

    /// Real pi text updates carry BOTH the cumulative message snapshot and an
    /// `assistantMessageEvent(type:text_delta)`. That event is not thinking chrome;
    /// it must fall through so the live text appears before `message_end`.
    func testTextDeltaAssistantEventStillStreamsMessageSnapshot() {
        var s = ChatSessionState()
        s = s.reduce(ev("message_update", [
            "assistantMessageEvent": .object([
                "type": .string("text_delta"), "delta": .string("answer"),
            ]),
            "message": .object([
                "role": .string("assistant"),
                "content": .array([.object([
                    "type": .string("text"), "text": .string("partial answer"),
                ])]),
            ]),
        ]))
        XCTAssertEqual(s.streamingText, "partial answer")
        XCTAssertTrue(s.messages.isEmpty, "live delta is not committed until message_end")
    }

    func testThinkingBlockCommitsOnThinkingEnd() {
        var s = ChatSessionState()
        s = s.reduce(ev("message_update", ["assistantMessageEvent": .object(["type": .string("thinking_start")])], 10))
        s = s.reduce(ev("message_update", ["assistantMessageEvent": .object([
            "type": .string("thinking_delta"), "delta": .string("hmm "),
        ])], 11))
        s = s.reduce(ev("message_update", ["assistantMessageEvent": .object([
            "type": .string("thinking_delta"), "delta": .string("let me think"),
        ])], 12))
        XCTAssertEqual(s.streamingThinking, "hmm let me think")
        s = s.reduce(ev("message_update", ["assistantMessageEvent": .object(["type": .string("thinking_end")])], 15))
        XCTAssertEqual(s.messages.count, 1)
        XCTAssertEqual(s.messages[0].role, .thinking)
        XCTAssertEqual(s.messages[0].content, "hmm let me think")
        XCTAssertEqual(s.messages[0].duration, 5) // 15 - 10
        XCTAssertEqual(s.streamingThinking, "")
    }

    func testToolCallLifecycle() {
        var s = ChatSessionState()
        s = s.reduce(ev("tool_execution_start", [
            "toolCallId": .string("t1"), "toolName": .string("bash"),
        ], 100))
        XCTAssertEqual(s.messages.count, 1)
        XCTAssertEqual(s.messages[0].role, .toolResult)
        XCTAssertEqual(s.messages[0].toolStatus, .running)
        XCTAssertEqual(s.currentTool, "bash")
        s = s.reduce(ev("tool_execution_end", [
            "toolCallId": .string("t1"), "result": .string("ok\nline2"), "isError": .bool(false),
        ], 150))
        XCTAssertEqual(s.messages.count, 1) // updated in place, not duplicated
        XCTAssertEqual(s.messages[0].toolStatus, .complete)
        XCTAssertEqual(s.messages[0].result, "ok\nline2")
        XCTAssertEqual(s.messages[0].duration, 50)
        XCTAssertNil(s.currentTool)
    }

    func testToolErrorStatus() {
        var s = ChatSessionState()
        s = s.reduce(ev("tool_execution_start", ["toolCallId": .string("t1"), "toolName": .string("edit")]))
        s = s.reduce(ev("tool_execution_end", ["toolCallId": .string("t1"), "isError": .bool(true)]))
        XCTAssertEqual(s.messages[0].toolStatus, .error)
    }

    /// The load-bearing ordering rule: streaming text present when a tool starts is
    /// flushed into a permanent assistant row BEFORE the tool row, so [text, toolCall]
    /// renders in content-array order (mirrors flushStreamingTextAsAssistantRow).
    func testStreamingTextFlushedBeforeToolRow() {
        var s = ChatSessionState()
        s = s.reduce(ev("message_start", ["message": .object(["role": .string("assistant")])]))
        s = s.reduce(ev("message_update", ["message": .object([
            "role": .string("assistant"),
            "content": .array([.object(["type": .string("text"), "text": .string("let me run it")])]),
        ])]))
        s = s.reduce(ev("tool_execution_start", ["toolCallId": .string("t1"), "toolName": .string("bash")]))
        XCTAssertEqual(s.messages.count, 2)
        XCTAssertEqual(s.messages[0].role, .assistant)
        XCTAssertEqual(s.messages[0].content, "let me run it")
        XCTAssertEqual(s.messages[1].role, .toolResult)
        XCTAssertTrue(s.streamingTextFlushed)
        // message_end must NOT double-push the already-flushed text.
        s = s.reduce(ev("message_end", ["message": .object(["role": .string("assistant")])]))
        XCTAssertEqual(s.messages.filter { $0.role == .assistant }.count, 1)
    }

    func testToolStartIdempotentOnReplay() {
        var s = ChatSessionState()
        let start = ev("tool_execution_start", ["toolCallId": .string("t1"), "toolName": .string("bash")])
        s = s.reduce(start)
        s = s.reduce(start) // replay
        XCTAssertEqual(s.messages.filter { $0.toolCallId == "t1" }.count, 1)
    }

    func testStatsAccumulate() {
        var s = ChatSessionState()
        s = s.reduce(ev("stats_update", [
            "tokensIn": .number(100), "tokensOut": .number(50), "cost": .number(0.01),
            "turnUsage": .object(["input": .number(100), "output": .number(50), "cacheRead": .number(10), "cacheWrite": .number(5)]),
            "contextUsage": .object(["tokens": .number(1200), "contextWindow": .number(200000)]),
        ]))
        XCTAssertEqual(s.tokensIn, 100)
        XCTAssertEqual(s.tokensOut, 50)
        XCTAssertEqual(s.cost, 0.01)
        XCTAssertEqual(s.cacheRead, 10)
        XCTAssertEqual(s.turnStats.count, 1)
        XCTAssertEqual(s.contextTokens, 1200)
        XCTAssertEqual(s.contextWindow, 200000)
    }

    func testModelSelect() {
        let s = ChatSessionState().reduce(ev("model_select", [
            "model": .object(["provider": .string("anthropic"), "id": .string("claude-opus")]),
            "thinkingLevel": .string("high"),
        ]))
        XCTAssertEqual(s.model, "anthropic/claude-opus")
        XCTAssertEqual(s.thinkingLevel, "high")
    }

    func testAgentStartEndTogglesStreaming() {
        var s = ChatSessionState().reduce(ev("agent_start"))
        XCTAssertTrue(s.isStreaming)
        XCTAssertEqual(s.status, "streaming")
        s = s.reduce(ev("agent_end", ["message": .object(["role": .string("assistant")])]))
        XCTAssertFalse(s.isStreaming)
        XCTAssertEqual(s.status, "idle")
    }

    func testSubagentLifecycle() {
        var s = ChatSessionState()
        s = s.reduce(ev("subagent_created", ["id": .string("a1"), "type": .string("Explore"), "description": .string("find X")]))
        XCTAssertEqual(s.subagents["a1"]?.status, "created")
        s = s.reduce(ev("subagent_started", ["id": .string("a1")]))
        XCTAssertEqual(s.subagents["a1"]?.status, "running")
        s = s.reduce(ev("subagent_completed", ["id": .string("a1"), "result": .string("found it")]))
        XCTAssertEqual(s.subagents["a1"]?.status, "completed")
        XCTAssertEqual(s.subagents["a1"]?.result, "found it")
        XCTAssertEqual(s.subagents["a1"]?.description, "find X") // preserved across transitions
    }

    func testBashOutputRow() {
        let s = ChatSessionState().reduce(ev("bash_output", [
            "command": .string("ls"), "output": .string("file.txt"), "exitCode": .number(0),
        ]))
        XCTAssertEqual(s.messages[0].role, .bashOutput)
        XCTAssertEqual(s.messages[0].content, "file.txt")
        XCTAssertEqual(s.messages[0].args["command"]?.stringValue, "ls")
    }

    func testCommandFeedbackUpsert() {
        var s = ChatSessionState()
        s = s.reduce(ev("command_feedback", ["command": .string("/compact"), "status": .string("started"), "message": .string("working")]))
        XCTAssertEqual(s.messages.count, 1)
        s = s.reduce(ev("command_feedback", ["command": .string("/compact"), "status": .string("completed"), "message": .string("done")]))
        XCTAssertEqual(s.messages.count, 1) // upserted in place
        XCTAssertEqual(s.messages[0].content, "done")
        XCTAssertEqual(s.messages[0].args["status"]?.stringValue, "completed")
    }

    func testUnknownEventRawFallback() {
        let s = ChatSessionState().reduce(ev("some_future_event", ["foo": .number(1)]))
        XCTAssertEqual(s.messages.count, 1)
        XCTAssertEqual(s.messages[0].role, .rawEvent)
        XCTAssertEqual(s.messages[0].toolName, "some_future_event")
        XCTAssertTrue(s.messages[0].content.contains("foo"))
    }

    func testReduceSequenceFoldsInOrder() {
        let events = [
            userMessage("hi"),
            ev("agent_start"),
            ev("message_start", ["message": .object(["role": .string("assistant")])]),
            ev("message_update", ["message": .object([
                "role": .string("assistant"),
                "content": .array([.object(["type": .string("text"), "text": .string("hello back")])]),
            ])]),
            ev("message_end", ["message": .object(["role": .string("assistant")])]),
            ev("agent_end", ["message": .object(["role": .string("assistant")])]),
        ]
        let s = ChatSessionState().reduce(events: events)
        XCTAssertEqual(s.messages.map { $0.role }, [.user, .assistant])
        XCTAssertEqual(s.messages[1].content, "hello back")
        XCTAssertFalse(s.isStreaming)
    }
}
