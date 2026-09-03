import XCTest
@testable import PiDashboardKit

final class QueueBadgePlacementTests: XCTestCase {

    func testZeroQueuedIsHiddenInBothLayouts() {
        XCTAssertEqual(
            ComposerLayout.queueBadgePlacement(queuedCount: 0, isMultiline: false), .hidden)
        XCTAssertEqual(
            ComposerLayout.queueBadgePlacement(queuedCount: 0, isMultiline: true), .hidden)
    }

    func testSingleRowUsesOwnRow() {
        XCTAssertEqual(
            ComposerLayout.queueBadgePlacement(queuedCount: 3, isMultiline: false), .ownRow)
    }

    func testMultilineUsesInlineControls() {
        XCTAssertEqual(
            ComposerLayout.queueBadgePlacement(queuedCount: 3, isMultiline: true), .inlineControls)
    }

    func testPlacementIsTotalOverTheMatrix() {
        for queuedCount in [0, 1, 5] {
            for isMultiline in [false, true] {
                let placement = ComposerLayout.queueBadgePlacement(
                    queuedCount: queuedCount, isMultiline: isMultiline)
                XCTAssertEqual(placement == .hidden, queuedCount == 0)
                XCTAssertEqual(
                    [placement == .ownRow, placement == .inlineControls].filter { $0 }.count,
                    queuedCount == 0 ? 0 : 1)
            }
        }
    }

    func testBadgeIsNeverInBothPlacesAtOnce() {
        for queuedCount in [0, 1, 7] {
            for isMultiline in [false, true] {
                let placement = ComposerLayout.queueBadgePlacement(
                    queuedCount: queuedCount, isMultiline: isMultiline)
                XCTAssertEqual(
                    [placement == .ownRow, placement == .inlineControls].filter { $0 }.count,
                    queuedCount == 0 ? 0 : 1,
                    "exactly one placement when queued, none when empty")
            }
        }
    }

    func testTextEditorRemainsOneUnconditionalSlot() throws {
        var iosDirectory = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { iosDirectory.deleteLastPathComponent() }
        let sourceURL = iosDirectory
            .appendingPathComponent("PiDashboard/Sources/AdaptiveComposer.swift")
        let source = try String(contentsOf: sourceURL, encoding: .utf8)
        let cardStart = try XCTUnwrap(source.range(of: "private var card: some View {"))
        let editorStart = try XCTUnwrap(
            source.range(of: "private var textEditor: some View {", range: cardStart.upperBound..<source.endIndex))
        let card = String(source[cardStart.lowerBound..<editorStart.lowerBound])
        let executableLines = card.split(separator: "\n", omittingEmptySubsequences: false).map { line in
            String(line.split(separator: "//", maxSplits: 1, omittingEmptySubsequences: false)[0])
                .trimmingCharacters(in: .whitespaces)
        }

        let editorLines = executableLines.indices.filter { executableLines[$0] == "textEditor" }
        XCTAssertEqual(editorLines.count, 1, "textEditor must occupy exactly one executable slot")
        let editorLine = try XCTUnwrap(editorLines.first)
        let stackLine = try XCTUnwrap(executableLines[..<editorLine].lastIndex {
            $0.contains("HStack(alignment: .bottom, spacing: 8) {")
        })
        let vStackLine = try XCTUnwrap(executableLines[..<stackLine].lastIndex {
            $0.contains("VStack(spacing: 8) {")
        })

        XCTAssertEqual(
            braceDepth(in: executableLines[vStackLine..<stackLine]), 1,
            "top HStack must remain an unconditional direct child of card VStack")
        XCTAssertEqual(
            braceDepth(in: executableLines[stackLine..<editorLine]), 1,
            "textEditor must remain an unconditional direct child of the top HStack")
    }

    private func braceDepth<S: Sequence>(in lines: S) -> Int where S.Element == String {
        lines.reduce(0) { depth, line in
            depth + line.filter { $0 == "{" }.count - line.filter { $0 == "}" }.count
        }
    }
}
