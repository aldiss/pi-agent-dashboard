import XCTest
@testable import PiDashboardKit

/// Unit tests for the pure voice-input helpers (transcript-append rule + locale
/// pick). These pin the PWA-parity append semantics and the Russian-preference
/// rule without any Speech/AVFoundation dependency.
final class VoiceInputTests: XCTestCase {

    // MARK: TranscriptAppender (parity with MobileComposer handleTranscript)

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

    func testAppendLiveStreamingHoldsBaseFixed() {
        // The live-dictation pattern: base fixed, partial grows → field shows base+partial.
        let base = "Note:"
        XCTAssertEqual(TranscriptAppender.append(base: base, transcript: "пин"), "Note: пин")
        XCTAssertEqual(TranscriptAppender.append(base: base, transcript: "пинг сервер"), "Note: пинг сервер")
    }

    // MARK: SpeechLocalePicker

    func testPrefersRussianWhenSupported() {
        let chosen = SpeechLocalePicker.preferred(
            available: ["en-US", "ru-RU", "de-DE"], device: "en-US")
        XCTAssertEqual(chosen, "ru-RU")
    }

    func testRussianMatchIsSeparatorAndCaseInsensitive() {
        // Recognizer may report `ru_RU`; still counts as Russian support.
        let chosen = SpeechLocalePicker.preferred(available: ["ru_RU"], device: "en-US")
        XCTAssertEqual(chosen, "ru-RU")
    }

    func testFallsBackToDeviceLocaleWhenNoRussian() {
        let chosen = SpeechLocalePicker.preferred(
            available: ["en-US", "fr-FR"], device: "fr-FR")
        XCTAssertEqual(chosen, "fr-FR")
    }

    func testDeviceLocaleReturnedWhenNeitherSupported() {
        let chosen = SpeechLocalePicker.preferred(
            available: ["en-US"], device: "ja-JP")
        XCTAssertEqual(chosen, "ja-JP")
    }

    func testRussianDeviceStillGetsRussian() {
        let chosen = SpeechLocalePicker.preferred(
            available: ["en-US", "ru-RU"], device: "ru-RU")
        XCTAssertEqual(chosen, "ru-RU")
    }
}
