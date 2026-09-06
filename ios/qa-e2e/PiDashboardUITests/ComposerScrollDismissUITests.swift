import XCTest
import PiDashboardKit

/// GESTURE DISMISS — drag down on the transcript to put the keyboard away.
/// This path never uses a composer toolbar control.
/// Keyboard-visible is a separate HARNESS precondition: with "Connect Hardware
/// Keyboard" enabled, a dismiss assertion could pass without exercising anything.
///
/// WHY THE NO-SEND CONTROL IS REAL HERE: fixture mode accepts sends without touching
/// the network, so an empty transcript cannot distinguish dismissal from a swallowed
/// send. `AdaptiveComposer.send()` still clears the draft on acceptance. An unchanged
/// marker is the no-send/no-queue control, including a send the harness would swallow.
/// The source-verified queue badge additionally checks visible queued state.
/// Uppercase-plus-digits markers avoid autocorrect.
///
/// One slow, continuous drag starts inside chat-scroll and ends near the window's
/// bottom, beyond the keyboard's top edge, so interactive dismissal can track the
/// finger through the keyboard's height. A brief initial press avoids long-press
/// menus; an explicit slow velocity avoids relying on a fast swipe's momentum.
/// Gesture reliability requires the remote red/green run, not a source inspection.
/// Keep this file byte-identical between the no-fix and fixed CI arms.
@MainActor
final class ComposerScrollDismissUITests: PiDashboardUITestCase {

    /// Type, drag the transcript down, and refocus without losing or sending the draft.
    func testScrollDismissPutsKeyboardAwayAndKeepsTheDraftWithoutSendingOrQueueing() {
        launch(Self.fixtureArgs)
        connectAndEnterList()
        _ = openChatBearing()
        let textView = focusComposer()

        // PRECONDITION — not the thing under test. No software keyboard means the
        // harness cannot exercise dismissal, rather than a failure of the product.
        XCTAssertTrue(waitForKeyboard(),
                      "HARNESS PRECONDITION FAILED, NOT A PRODUCT FAILURE: no software "
                      + "keyboard appeared after focusing the composer. In Simulator turn "
                      + "OFF I/O > Keyboard > Connect Hardware Keyboard and re-run. Nothing "
                      + "below this line has been exercised.")

        let marker = "SCROLLDISMISS84"
        textView.typeText(marker)
        XCTAssertTrue(waitForValueContains(textView, marker),
                      "HARNESS PRECONDITION FAILED: the marker did not reach the field")
        XCTAssertEqual(textView.value as? String, marker,
                       "HARNESS PRECONDITION FAILED: draft must equal the typed marker")
        XCTAssertFalse(el("mobile-composer-queue-badge").exists,
                       "HARNESS PRECONDITION FAILED: queued state exists before dismissal")

        let transcript = waitFor("chat-scroll", 6)
        XCTAssertTrue(transcript.isHittable,
                      "HARNESS PRECONDITION FAILED: chat-scroll is not reachable")
        let window = app.windows.firstMatch
        let start = transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.8))
        let startPoint = start.screenPoint
        let windowFrame = window.frame
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.exists,
                      "HARNESS PRECONDITION FAILED: keyboard vanished before the drag")
        XCTAssertTrue(transcript.frame.contains(startPoint) && windowFrame.contains(startPoint),
                      "HARNESS PRECONDITION FAILED: drag must start inside the visible transcript")
        XCTAssertLessThan(startPoint.y, keyboard.frame.minY,
                          "HARNESS PRECONDITION FAILED: drag starts behind the keyboard")
        let finish = window.coordinate(withNormalizedOffset: .zero).withOffset(
            CGVector(dx: startPoint.x - windowFrame.minX, dy: windowFrame.height - 24))
        XCTAssertGreaterThan(finish.screenPoint.y, keyboard.frame.minY,
                             "HARNESS PRECONDITION FAILED: drag must cross the keyboard's top edge")
        start.press(forDuration: 0.05, thenDragTo: finish,
                    withVelocity: .slow, thenHoldForDuration: 0.1)

        // THE ASSERTION: the gesture alone must put the software keyboard away.
        XCTAssertTrue(waitForKeyboardGone(),
                      "PRODUCT FAILURE: keyboard is still visible after dragging down on chat-scroll")

        // A send accepted by the fixture would clear this field even with no network.
        XCTAssertTrue(waitForValueContains(textView, marker),
                      "dismiss must not send: send() clears the composer on acceptance")
        XCTAssertEqual(textView.value as? String, marker,
                       "draft must remain exactly unchanged after scroll dismissal")
        XCTAssertFalse(el("mobile-composer-queue-badge").exists,
                       "scroll dismissal must not queue a message")

        textView.tap()
        XCTAssertTrue(waitForKeyboard(), "refocusing the composer raises the keyboard again")
        XCTAssertTrue(waitForValueContains(textView, marker),
                      "draft survives dismiss -> refocus with no save/restore path")
        XCTAssertEqual(textView.value as? String, marker,
                       "draft must remain exactly unchanged after refocusing")
        XCTAssertFalse(el("mobile-composer-queue-badge").exists,
                       "refocusing must not queue a message")
    }

    // MARK: - local helpers (file-private by suite convention)

    private func focusComposer() -> XCUIElement {
        let textView = waitFor("mobile-composer-textarea", 6)
        textView.tap()
        return textView
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

    private func waitForValueContains(_ textView: XCUIElement, _ needle: String,
                                      _ timeout: TimeInterval = 5) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if (textView.value as? String)?.contains(needle) == true { return true }
            usleep(150_000)
        }
        return (textView.value as? String)?.contains(needle) == true
    }
}
