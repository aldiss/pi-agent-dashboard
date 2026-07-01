import XCTest
@testable import PiDashboardKit

/// Cluster 5 — the pure a11y helpers: the non-color status→spoken-label mapping and
/// the reduce-motion gate. Pinning these in `swift test` keeps the VoiceOver wording +
/// motion policy from silently drifting (the actual `.accessibilityLabel` /
/// animation-gating is app-layer).
final class A11yTests: XCTestCase {

    // MARK: statusLabel — the non-color status cue

    func testStatusLabelMapsEachState() {
        XCTAssertEqual(A11yStatus.statusLabel("streaming"), "Working")
        XCTAssertEqual(A11yStatus.statusLabel("active"), "Idle")
        XCTAssertEqual(A11yStatus.statusLabel("idle"), "Idle")
        XCTAssertEqual(A11yStatus.statusLabel("ended"), "Ended")
    }

    /// error + ask_user take precedence over the raw status (matches the card's visual
    /// meaning — an errored/awaiting session reads that way regardless of `status`).
    func testStatusLabelPrecedence() {
        XCTAssertEqual(A11yStatus.statusLabel("streaming", hasError: true), "Error",
                       "error beats working")
        XCTAssertEqual(A11yStatus.statusLabel("ended", hasError: true), "Error",
                       "error beats ended")
        XCTAssertEqual(A11yStatus.statusLabel("streaming", currentTool: "ask_user"),
                       "Waiting for your input", "an ask beats working")
        // ended beats ask (a finished session isn't awaiting input).
        XCTAssertEqual(A11yStatus.statusLabel("ended", currentTool: "ask_user"), "Ended")
    }

    /// Unknown / nil / a novel status the server may add → a sensible spoken label
    /// (never empty, never a bare color).
    func testStatusLabelFallback() {
        XCTAssertEqual(A11yStatus.statusLabel(nil), "Unknown")
        XCTAssertEqual(A11yStatus.statusLabel(""), "Unknown")
        XCTAssertEqual(A11yStatus.statusLabel("compacting"), "Compacting", "novel status capitalized")
    }

    /// A non-ask tool doesn't flip the label to "waiting" — only ask_user does.
    func testNonAskToolStaysWorking() {
        XCTAssertEqual(A11yStatus.statusLabel("streaming", currentTool: "bash"), "Working")
    }

    // MARK: reduce-motion gate

    func testPulsesEnabledGate() {
        XCTAssertTrue(A11yMotion.pulsesEnabled(reduceMotion: false), "motion allowed by default")
        XCTAssertFalse(A11yMotion.pulsesEnabled(reduceMotion: true), "no pulsing under Reduce Motion")
    }
}
