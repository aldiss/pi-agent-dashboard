import XCTest
import PiDashboardKit

/// F4 (the North Star) + F5: adaptive-composer hysteresis and send gating, driven
/// through the §A identifiers against the hermetic `UITestFixtures` set. These assert the
/// SAME behavior `ComposerLayout` pins at the unit layer, but end-to-end through the
/// real SwiftUI composer + UITextView.
@MainActor
final class ComposerUITests: PiDashboardUITestCase {

    /// Open a fixture session's chat and return once the composer is up.
    private func openComposer() {
        launch()
        connectAndEnterList()
        openChat(fixtureSessions.first ?? fixtureSession("any") { _ in true })
        _ = waitFor("mobile-composer", 10)
    }

    // MARK: F4 — single-row ⇄ multiline hysteresis

    /// type ≤20 → single-row; type >20 wrapping chars → multiline; delete back to
    /// ≤20 → single-row. No flip-flop at the 20/45 boundary (mirrors ComposerLayout).
    func testF4_ComposerHysteresisSingleRowMultilineRevert() {
        openComposer()

        // starts single-row.
        XCTAssertTrue(waitForComposerLayout("single-row"), "composer starts single-row")
        attach("F4-single-row")

        let textView = waitFor("mobile-composer-textarea", 6)
        textView.tap()

        // a short (≤20) entry stays single-row.
        textView.typeText("short note")
        XCTAssertTrue(waitForComposerLayout("single-row"), "≤20 chars stays single-row")

        // a long, wrapping entry flips to multiline (the hysteresis entry).
        textView.typeText(" that keeps going well past the twenty-character wrap threshold on iPhone")
        XCTAssertTrue(waitForComposerLayout("multiline"), "long wrapping text → multiline")
        attach("F4-multiline")

        // clear the field → reverts to single-row (back across the floor).
        clearTextView(textView)
        XCTAssertTrue(waitForComposerLayout("single-row"), "deleting back to empty reverts to single-row")
        attach("F4-reverted")
    }

    /// A newline ALWAYS forces multiline, even for a short entry (mirrors the
    /// `hasNewline ? true` clause). Enter inserts a newline; it must NEVER send.
    func testF4_NewlineForcesMultilineAndNeverSends() {
        openComposer()
        let textView = waitFor("mobile-composer-textarea", 6)
        textView.tap()
        textView.typeText("hi")
        XCTAssertTrue(waitForComposerLayout("single-row"), "short text single-row before newline")

        textView.typeText("\n")  // Enter
        XCTAssertTrue(waitForComposerLayout("multiline"), "a newline forces multiline")
        // Enter did NOT send: the text (with newline) is still in the field.
        if let v = textView.value as? String {
            XCTAssertTrue(v.contains("hi"), "text retained — Enter inserted a newline, did not send")
        }
        attach("F4-newline-multiline")
    }

    // MARK: F5 — send gating

    /// empty/whitespace → send disabled; non-empty → enabled. (canSend mirror.)
    func testF5_SendButtonGating() {
        openComposer()
        let send = waitFor("mobile-composer-send", 6)

        // empty → disabled.
        XCTAssertFalse(send.isEnabled, "send disabled when the composer is empty")

        let textView = waitFor("mobile-composer-textarea", 6)
        textView.tap()

        // whitespace-only → still disabled.
        textView.typeText("   ")
        XCTAssertFalse(send.isEnabled, "send disabled for whitespace-only text")

        // real text → enabled.
        textView.typeText("ship it")
        XCTAssertTrue(send.isEnabled, "send enabled once there is non-whitespace text")
        attach("F5-send-enabled")

        // clear → disabled again.
        clearTextView(textView)
        XCTAssertFalse(send.isEnabled, "send disabled again after clearing")
    }

    // MARK: helpers

    /// Robustly drain a UITextView to empty. The real-target run revealed BOTH
    /// failure modes of the naive approaches:
    ///   • NOT re-tapping → the field loses keyboard focus after the assertions, so
    ///     `typeText(delete…)` fails with "Neither element nor any descendant has
    ///     keyboard focus".
    ///   • A plain `tap()` on a WRAPPED multi-line UITextView lands the caret where
    ///     the tap hit (mid-text) → backspaces leave a trailing tail → stays multiline.
    /// Fix: tap the BOTTOM-RIGHT corner each iteration — that regains focus AND lands
    /// the caret at the end of the text (empty space past the last glyph snaps the
    /// caret to the final character), so a generous backspace run drains fully. Poll
    /// the value (re-read each pass) until empty (empty UITextView reports its
    /// placeholder "Message") or a hard cap.
    private func clearTextView(_ tv: XCUIElement) {
        for _ in 0..<16 {
            let current = (tv.value as? String) ?? ""
            if current.isEmpty || current == "Message" { return }
            // bottom-right → focus + caret-at-end on a wrapped field.
            tv.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.92)).tap()
            let n = max(current.count + 6, 12)
            tv.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: n))
        }
    }
}
