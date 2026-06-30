import XCTest
@testable import PiDashboardKit

/// Unit tests for the pure transcript-append rule (parity with MobileComposer
/// `handleTranscript`). No AVFoundation dependency.
final class VoiceInputTests: XCTestCase {

    func testAppendOntoEmptyIsTranscriptItself() {
        XCTAssertEqual(TranscriptAppender.append(base: "", transcript: "привет"), "привет")
    }

    func testAppendInsertsSeparatingSpace() {
        XCTAssertEqual(TranscriptAppender.append(base: "hello", transcript: "world"), "hello world")
    }

    func testAppendNoDoubleSpaceWhenBaseEndsWithSpace() {
        XCTAssertEqual(TranscriptAppender.append(base: "hello ", transcript: "world"), "hello world")
    }

    func testAppendNoSpaceWhenBaseEndsWithNewline() {
        XCTAssertEqual(TranscriptAppender.append(base: "line1\n", transcript: "line2"), "line1\nline2")
    }

    func testAppendRussianTranscriptOntoDraft() {
        XCTAssertEqual(
            TranscriptAppender.append(base: "Note:", transcript: "пингани сервер"),
            "Note: пингани сервер")
    }
}
