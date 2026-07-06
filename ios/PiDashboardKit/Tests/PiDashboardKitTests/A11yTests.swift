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

    /// BUILD-2: the TRAVEL gate (one-shot transitions/presses) — same reduce-motion
    /// keying as the pulse gate, distinct name. This is the single policy the app-layer
    /// `Motion.animation(_:reduceMotion:)` delegates to (spring when true, nil when off).
    func testTravelEnabledGate() {
        XCTAssertTrue(A11yMotion.travelEnabled(reduceMotion: false), "travel allowed by default")
        XCTAssertFalse(A11yMotion.travelEnabled(reduceMotion: true), "no travel under Reduce Motion")
    }

    /// Pulse + travel gates agree (both keyed off the one flag) — no split-brain policy.
    func testPulseAndTravelGatesAgree() {
        for rm in [true, false] {
            XCTAssertEqual(A11yMotion.pulsesEnabled(reduceMotion: rm),
                           A11yMotion.travelEnabled(reduceMotion: rm))
        }
    }

    /// Haptics BYPASS the gate — a tactile tick is an a11y aid, so it fires even under
    /// Reduce Motion (always true, both flag states).
    func testHapticsBypassReduceMotion() {
        XCTAssertTrue(A11yMotion.hapticsAllowed(reduceMotion: true), "haptics fire under Reduce Motion")
        XCTAssertTrue(A11yMotion.hapticsAllowed(reduceMotion: false))
    }

    // MARK: SpringSpec — the motion vocabulary math (web {stiffness,damping} → SwiftUI)

    /// The exact ported params (response = 2π/√stiffness, dampingFraction =
    /// damping/(2√stiffness)). Pinned here so the design vocabulary can't silently drift.
    func testSpringSpecParamFidelity() {
        XCTAssertEqual(SpringSpec.smooth.response, 0.31, accuracy: 0.0001)
        XCTAssertEqual(SpringSpec.smooth.dampingFraction, 1.0, accuracy: 0.0001,
                       "smooth is over-damped in web (≈1.05) → clamped to 1.0, no overshoot")
        XCTAssertEqual(SpringSpec.gentle.response, 0.41, accuracy: 0.0001)
        XCTAssertEqual(SpringSpec.gentle.dampingFraction, 0.97, accuracy: 0.0001)
        XCTAssertEqual(SpringSpec.snappy.response, 0.28, accuracy: 0.0001)
        XCTAssertEqual(SpringSpec.snappy.dampingFraction, 0.75, accuracy: 0.0001)
    }

    /// The wired tokens are NON-bouncy (dampingFraction ≥ 1 for smooth, < 1 but high for
    /// gentle) and NOT guarded; snappy is the ONE guarded/under-damped token, unwired.
    func testSpringSpecGuardsAndDamping() {
        XCTAssertFalse(SpringSpec.smooth.isGuarded, "smooth ships")
        XCTAssertFalse(SpringSpec.gentle.isGuarded, "gentle ships")
        XCTAssertTrue(SpringSpec.snappy.isGuarded, "snappy withheld until sign-off")
        // smooth never overshoots (critically/over-damped); snappy is the under-damped one.
        XCTAssertGreaterThanOrEqual(SpringSpec.smooth.dampingFraction, 1.0)
        XCTAssertLessThan(SpringSpec.snappy.dampingFraction, 1.0)
        // The three tokens are distinct.
        XCTAssertNotEqual(SpringSpec.smooth, SpringSpec.gentle)
        XCTAssertNotEqual(SpringSpec.gentle, SpringSpec.snappy)
    }
}
