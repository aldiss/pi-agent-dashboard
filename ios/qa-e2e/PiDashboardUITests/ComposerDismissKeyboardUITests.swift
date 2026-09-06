import XCTest
import PiDashboardKit

/// Gesture-only dismissal must not expose the former Done accessory.
/// The three toolbar-action/accessibility tests are retired with that control.
/// ComposerScrollDismissUITests retains dismissal, draft/refocus and no-send/no-queue
/// coverage through the transcript gesture; this suite checks the removed surface.
@MainActor
final class ComposerDismissKeyboardUITests: PiDashboardUITestCase {

    func testDismissAccessoryIsAbsentWhileEditing() {
        launch(Self.fixtureArgs)
        connectAndEnterList()
        _ = openChatBearing()
        let textView = waitFor("mobile-composer-textarea", 6)
        textView.tap()
        XCTAssertTrue(waitForKeyboard(),
                      "HARNESS PRECONDITION FAILED, NOT A PRODUCT FAILURE: no software "
                      + "keyboard appeared after focusing the composer. In Simulator turn "
                      + "OFF I/O > Keyboard > Connect Hardware Keyboard and re-run.")

        // Positive control on the SAME type-agnostic lookup surface: a broken query
        // would report both identifiers absent. The removed identifier was verified
        // against the former UIBarButtonItem in GrowingTextView.swift before removal.
        XCTAssertTrue(el("mobile-composer-textarea").exists,
                      "HARNESS PRECONDITION FAILED: composer lookup must find the live editor")
        XCTAssertFalse(el("mobile-composer-dismiss-keyboard").exists,
                       "gesture-only dismissal must not expose the former Done accessory")

        textView.typeText("GESTUREONLY63")
        XCTAssertTrue(waitForValue("mobile-composer-textarea", equals: "GESTUREONLY63"),
                      "the positive-control editor must remain editable without an accessory")
        XCTAssertFalse(el("mobile-composer-dismiss-keyboard").exists,
                       "typing a draft must not reinstall the dismiss accessory")
    }

    private func waitForKeyboard(_ timeout: TimeInterval = 5) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if app.keyboards.firstMatch.exists { return true }
            usleep(150_000)
        }
        return app.keyboards.firstMatch.exists
    }
}
