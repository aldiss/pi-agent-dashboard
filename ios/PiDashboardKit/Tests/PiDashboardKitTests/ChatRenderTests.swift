import XCTest
@testable import PiDashboardKit

/// Tests for the pure rich-chat render helpers (Batch 1): tool-args pretty-print,
/// thinking-collapse threshold, show-more truncation. No UI/MarkdownUI dependency.
final class ChatRenderTests: XCTestCase {

    func testPrettyArgsSortedAndIndented() {
        let args: [String: JSONValue] = [
            "command": .string("swift test"),
            "label": .string("run tests"),
        ]
        let out = ChatRender.prettyArgs(args)
        // Sorted keys → command before label; pretty-printed (multi-line + spacing).
        XCTAssertTrue(out.contains("\"command\" : \"swift test\""))
        XCTAssertTrue(out.contains("\"label\" : \"run tests\""))
        XCTAssertTrue(out.contains("\n"))
        XCTAssertLessThan(out.range(of: "command")!.lowerBound, out.range(of: "label")!.lowerBound)
    }

    func testPrettyArgsEmptyIsEmpty() {
        XCTAssertEqual(ChatRender.prettyArgs([:]), "")
    }

    func testPrettyArgsNrestedValues() {
        let args: [String: JSONValue] = [
            "opts": .object(["force": .bool(true), "count": .number(3)]),
        ]
        let out = ChatRender.prettyArgs(args)
        XCTAssertTrue(out.contains("force"))
        XCTAssertTrue(out.contains("count"))
    }

    func testToolSummaryMatchesPWAForCommonTools() {
        XCTAssertEqual(ChatRender.toolSummary("read", args: ["path": .string("/tmp/a")]), "Read /tmp/a")
        XCTAssertEqual(ChatRender.toolSummary("edit", args: ["path": .string("a.swift")]), "Edit a.swift")
        XCTAssertEqual(ChatRender.toolSummary("write", args: [:]), "Write file")
        XCTAssertEqual(ChatRender.toolSummary("grep", args: ["pattern": .string("nonce")]), "Grep nonce")
        XCTAssertEqual(ChatRender.toolSummary("find", args: ["glob": .string("*.swift")]), "Find *.swift")
        XCTAssertEqual(ChatRender.toolSummary("ls", args: [:]), "ls .")
    }

    func testBashToolSummaryClipsLongCommandAtSixtyCharacters() {
        let command = String(repeating: "x", count: 80)
        XCTAssertEqual(ChatRender.toolSummary("bash", args: ["command": .string(command)]),
                       "$ " + String(repeating: "x", count: 60))
    }

    func testUnknownToolSummaryFallsBackToName() {
        XCTAssertEqual(ChatRender.toolSummary("custom_tool", args: ["x": .number(1)]), "custom_tool")
    }

    func testShouldCollapseThinkingLongCollapses() {
        let long = String(repeating: "x", count: ChatRender.thinkingCollapseThreshold + 1)
        XCTAssertTrue(ChatRender.shouldCollapseThinking(long))
    }

    func testShouldCollapseThinkingShortStaysOpen() {
        XCTAssertFalse(ChatRender.shouldCollapseThinking("a quick aside"))
    }

    func testTruncatedClipsBeyondMaxLines() {
        let text = (1...20).map { "line\($0)" }.joined(separator: "\n")
        let (visible, clipped) = ChatRender.truncated(text, maxLines: 5)
        XCTAssertTrue(clipped)
        XCTAssertEqual(visible.split(separator: "\n").count, 5)
        XCTAssertTrue(visible.hasPrefix("line1"))
        XCTAssertFalse(visible.contains("line6"))
    }

    func testTruncatedKeepsShortTextWhole() {
        let text = "line1\nline2"
        let (visible, clipped) = ChatRender.truncated(text, maxLines: 5)
        XCTAssertFalse(clipped)
        XCTAssertEqual(visible, text)
    }
}
