import XCTest
@testable import PiDashboardKit

/// Composer focus-loss regression (the operator hit it live: typing while a session
/// streams events → keyboard drops + draft lost). The two PURE guards behind the SwiftUI
/// fix are pinned here:
///  - `isMultiline` must be a function of TEXT only — repeated re-render measures with
///    UNCHANGED text must never flip it (a spurious flip tore the UITextView down).
///  - `shouldApplyBinding` must let programmatic edits (send-clear / voice-append)
///    through while NEVER echoing a lagging re-render back onto in-flight typing.
/// (The structural identity + `bounds.width==0` skip live in the SwiftUI/UIKit layer,
/// verified by SwiftPilot's build gate + the XCUITest hysteresis assert — not here.)
final class ComposerFocusTests: XCTestCase {

    // MARK: isMultiline stability under streaming re-render churn

    /// The bug: while a session works, `updateUIView` fires on every event and used to
    /// re-measure → churn `isMultiline` → teardown. With the same TEXT, repeated
    /// measures (even wildly varying / transient-zero heights) must NOT flip the state.
    func testUnchangedTextNeverFlipsAcrossRepeatedMeasures() {
        // Single-row draft (short) — hammer it with junk heights a re-layout might yield.
        var state = false
        for h in [0.0, 999, 20, 45, 46, 0, 200, 1] {
            state = ComposerLayout.isMultiline(previous: state, text: "hi there", contentHeight: h)
            XCTAssertFalse(state, "short text stays single-row regardless of measured height \(h)")
        }
        // Long multiline draft — once column, stays column across the same churn.
        let long = String(repeating: "x", count: 40)
        state = true
        for h in [0.0, 999, 10, 46, 0, 45, 200] {
            state = ComposerLayout.isMultiline(previous: state, text: long, contentHeight: h)
            XCTAssertTrue(state, "long text stays multiline regardless of measured height \(h)")
        }
    }

    /// Crossing the boundary flips EXACTLY once, then holds (no per-render re-flip).
    func testBoundaryFlipsOnceThenHolds() {
        let long = String(repeating: "x", count: 25)
        // Enters column on the first wrapped+long measure…
        var state = ComposerLayout.isMultiline(previous: false, text: long, contentHeight: 50)
        XCTAssertTrue(state, "wrapped + long → enters multiline")
        // …and STAYS on every subsequent re-render measure (length alone holds it).
        for h in [0.0, 30, 999, 46, 0] {
            state = ComposerLayout.isMultiline(previous: state, text: long, contentHeight: h)
            XCTAssertTrue(state, "stays multiline by length alone (measure \(h) ignored)")
        }
    }

    /// No oscillation pocket at the shared length floor (20): 21 chars enters and holds.
    func testNoOscillationAtThreshold() {
        let at21 = String(repeating: "x", count: 21)
        var state = ComposerLayout.isMultiline(previous: false, text: at21, contentHeight: 46)
        XCTAssertTrue(state, "21 wrapped chars enters column")
        // Re-measure many times with the same text: never falls back out.
        for _ in 0..<10 {
            state = ComposerLayout.isMultiline(previous: state, text: at21, contentHeight: 0)
            XCTAssertTrue(state, "no flip-flop: 21 chars keeps column with no re-measure")
        }
    }

    // MARK: shouldApplyBinding — programmatic push vs in-flight-typing clobber

    /// In-sync field ⇒ nothing to do (idempotent updateUIView never rewrites text).
    func testBindingNoOpWhenEqual() {
        XCTAssertFalse(ComposerLayout.shouldApplyBinding(
            fieldText: "hello", boundText: "hello", isFirstResponder: true, isProgrammatic: false))
    }

    /// THE BUG: a lagging streaming re-render carries a STALE bound value while the user
    /// is typing (field is first responder). It must NOT be pushed back — that dropped
    /// the in-flight character + reset the caret.
    func testFocusedUserEchoIsNotClobbered() {
        // Field already has the fresh keystroke ("hell"); a re-render still holds "hel".
        XCTAssertFalse(ComposerLayout.shouldApplyBinding(
            fieldText: "hell", boundText: "hel", isFirstResponder: true, isProgrammatic: false),
            "focused non-programmatic re-render must not clobber in-flight typing")
    }

    /// Send-clear is programmatic ⇒ applies even while the field is first responder.
    func testProgrammaticClearAppliesWhileFocused() {
        XCTAssertTrue(ComposerLayout.shouldApplyBinding(
            fieldText: "draft to send", boundText: "", isFirstResponder: true, isProgrammatic: true))
    }

    /// Voice-append is programmatic ⇒ applies while focused (mic tapped mid-edit).
    func testProgrammaticAppendAppliesWhileFocused() {
        XCTAssertTrue(ComposerLayout.shouldApplyBinding(
            fieldText: "note ", boundText: "note transcribed words",
            isFirstResponder: true, isProgrammatic: true))
    }

    /// A clear always applies (even non-programmatic) — empty is safe + intended.
    func testEmptyBoundAlwaysApplies() {
        XCTAssertTrue(ComposerLayout.shouldApplyBinding(
            fieldText: "stale", boundText: "", isFirstResponder: true, isProgrammatic: false))
    }

    /// An IDLE field (not first responder) accepts an external value — e.g. a draft
    /// restored while the keyboard is down.
    func testIdleFieldAcceptsExternalValue() {
        XCTAssertTrue(ComposerLayout.shouldApplyBinding(
            fieldText: "", boundText: "restored draft", isFirstResponder: false, isProgrammatic: false))
    }

    /// Focused, non-programmatic, non-empty, differing → the ONLY skip case (the guard).
    func testFocusedExternalNonEmptyIsSkipped() {
        XCTAssertFalse(ComposerLayout.shouldApplyBinding(
            fieldText: "user typing", boundText: "something else",
            isFirstResponder: true, isProgrammatic: false))
    }
}
