import XCTest
import PiDashboardKit

/// KEYBOARD DISMISS — the operator's bug, open since 2026-07-21 (dl-10754): once the
/// chat composer has focus there is no way to put the keyboard away. The PWA can; the
/// native app could not. The fix is a single `Done` control in the composer's keyboard
/// accessory (`ComposerTextView.installDismissAccessory`) whose entire action is
/// `resignFirstResponder`.
///
/// STATUS AT AUTHORING: **WRITTEN BUT UNRUN.** The machine was under a memory hold
/// (31 GB of 32 GB used, 16.2 GB of 17.4 GB swap consumed, load ~24) and the supervising
/// dispatcher barred simulator boots and builds. Nothing here has executed. Do not read
/// it as passing; the first run is the evidence.
///
/// PRECONDITION IS SEPARATE FROM ASSERTION, DELIBERATELY. In the simulator a software
/// keyboard does not appear at all when "Connect Hardware Keyboard" is enabled, and a
/// dismiss test would then pass for the wrong reason — the keyboard was never up. So
/// keyboard-appeared is checked FIRST and its failure message says, in terms, that the
/// failure is the HARNESS and not the product. A test that cannot tell those apart is
/// not a test of the product.
///
/// WHY THE NO-SEND CONTROL IS REAL HERE, since the obvious version would not be. The
/// hermetic harness no-ops the network send (`DashboardStore.sendPrompt` returns early
/// at `guard !isUITest else { return true }`), so "no message appeared in the transcript"
/// would pass whether dismiss is clean OR the harness swallowed a real send — a
/// two-valued pass, which is not a control. But `AdaptiveComposer.send()` clears the
/// draft COMPOSER-side (`text = ""`, `images = []`) once `onSend` returns accepted, and
/// in fixture mode it returns `true`. So a wrongly-triggered send WOULD wipe the draft
/// even here. "Marker still present after dismiss" is therefore single-valued and is the
/// control: it can only stay put if dismiss did not send.
///
/// MARKER technique matches `ComposerFocusUITests`: uppercase-plus-digits tokens are
/// non-dictionary, so autocorrect and predictive text leave them untouched and the exact
/// typed text is recoverable from the field value.
@MainActor
final class ComposerDismissKeyboardUITests: PiDashboardUITestCase {

    /// The operator's path, end to end: type, put the keyboard away, get it back, and
    /// find the draft exactly as it was.
    func testDismissPutsKeyboardAwayAndKeepsTheDraft() {
        launch(Self.fixtureArgs)
        connectAndEnterList()
        _ = openChatBearing()
        let tv = focusComposer()

        // PRECONDITION — not the thing under test. If this fails the SIMULATOR never
        // raised a software keyboard (almost always "Connect Hardware Keyboard" being
        // on), and the verdict below would be meaningless rather than wrong.
        XCTAssertTrue(waitForKeyboard(),
                      "HARNESS PRECONDITION FAILED, NOT A PRODUCT FAILURE: no software "
                      + "keyboard appeared after focusing the composer. In Simulator turn "
                      + "OFF I/O > Keyboard > Connect Hardware Keyboard and re-run. Nothing "
                      + "below this line has been exercised.")

        tv.typeText("DISMISS42")
        XCTAssertTrue(waitForValueContains(tv, "DISMISS42"),
                      "precondition: the marker actually reached the field")

        dismissButton().tap()

        // THE ASSERTION: the keyboard is gone.
        XCTAssertTrue(waitForKeyboardGone(),
                      "tapping Done must dismiss the keyboard")

        // AND the draft is untouched — which is also the no-send control (see header).
        XCTAssertTrue(waitForValueContains(tv, "DISMISS42"),
                      "draft must survive dismissal; a cleared field here means dismiss "
                      + "triggered a SEND, because send() is what clears the composer")

        // Refocus: the draft is still there and editing resumes.
        tv.tap()
        XCTAssertTrue(waitForKeyboard(), "refocusing the composer raises the keyboard again")
        XCTAssertTrue(waitForValueContains(tv, "DISMISS42"),
                      "draft survives dismiss -> refocus with no save/restore path")
    }

    /// CONTROL: dismissal must not send or queue. Asserted through the draft, because
    /// the transcript cannot discriminate under a harness that no-ops the network send.
    func testDismissDoesNotSendOrQueue() {
        launch(Self.fixtureArgs)
        connectAndEnterList()
        _ = openChatBearing()
        let tv = focusComposer()
        XCTAssertTrue(waitForKeyboard(),
                      "HARNESS PRECONDITION FAILED, NOT A PRODUCT FAILURE: no software "
                      + "keyboard appeared; see I/O > Keyboard > Connect Hardware Keyboard.")

        tv.typeText("NOSEND77")
        XCTAssertTrue(waitForValueContains(tv, "NOSEND77"))

        dismissButton().tap()
        _ = waitForKeyboardGone()

        // A send would have cleared the composer. It did not, so nothing was sent.
        XCTAssertTrue(waitForValueContains(tv, "NOSEND77"),
                      "dismiss must not send: send() clears text + images, so a surviving "
                      + "draft is positive evidence that no send fired")
        // And no queued-state affordance should have appeared. Identifier verified
        // against the source (`AdaptiveComposer.swift:376`) rather than invented: an
        // assertFalse on an identifier that does not exist passes vacuously and is not
        // a control at all.
        XCTAssertFalse(app.staticTexts["mobile-composer-queue-badge"].exists,
                       "dismiss must not queue a message")
    }

    /// The control is reachable and labelled for VoiceOver.
    func testDismissControlIsExposedToAccessibility() {
        launch(Self.fixtureArgs)
        connectAndEnterList()
        _ = openChatBearing()
        _ = focusComposer()
        XCTAssertTrue(waitForKeyboard(),
                      "HARNESS PRECONDITION FAILED, NOT A PRODUCT FAILURE: no software keyboard.")

        let done = dismissButton()
        XCTAssertTrue(done.exists, "the dismiss control is present while editing")
        XCTAssertTrue(done.isHittable, "the dismiss control is reachable, not occluded")
        XCTAssertEqual(done.label, "Dismiss keyboard",
                       "accessibility label is the spoken name, not the visible title")
    }

    // MARK: - local helpers (file-private by suite convention)

    private func dismissButton() -> XCUIElement {
        app.buttons["mobile-composer-dismiss-keyboard"]
    }

    private func focusComposer() -> XCUIElement {
        let tv = waitFor("mobile-composer-textarea", 6)
        tv.tap()
        return tv
    }

    private func waitForKeyboard(_ timeout: TimeInterval = 5) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if app.keyboards.firstMatch.exists { return true }
            usleep(150_000)
        }
        return app.keyboards.firstMatch.exists
    }

    private func waitForKeyboardGone(_ timeout: TimeInterval = 5) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if !app.keyboards.firstMatch.exists { return true }
            usleep(150_000)
        }
        return !app.keyboards.firstMatch.exists
    }

    private func waitForValueContains(_ tv: XCUIElement, _ needle: String,
                                      _ timeout: TimeInterval = 5) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if (tv.value as? String)?.contains(needle) == true { return true }
            usleep(150_000)
        }
        return (tv.value as? String)?.contains(needle) == true
    }
}
