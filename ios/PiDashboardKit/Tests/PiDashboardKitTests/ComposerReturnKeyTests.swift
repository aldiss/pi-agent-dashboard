import XCTest
@testable import PiDashboardKit

/// Tests for the hardware-Return contract the operator asked for: **Enter sends,
/// Shift+Enter inserts a newline** — for an EXTERNAL keyboard only.
///
/// STATUS AT AUTHORING: **WRITTEN BUT UNRUN.** The machine was under a memory hold
/// (31 GB of 32 GB used, 16.2 GB of 17.4 GB swap consumed, load ~24) and the supervising
/// dispatcher barred running builds and tests. Do not read these as passing. The first
/// `swift test` run is the evidence; until then they are a specification.
///
/// EVIDENCE BOUNDARY — deliberate, do not erase. These prove the DECISION only.
/// They do NOT prove the `UIKeyCommand` wiring in `GrowingTextView`, and they do NOT
/// prove that the on-screen keyboard is left alone. That rests on `UIKeyCommand` firing
/// for physical keyboards only, which is UIKit behaviour reachable only on a device or
/// simulator. A green run here says the policy is right, not that the feature works.
final class ComposerReturnKeyTests: XCTestCase {

    func testEnterSendsWhenComposerHasText() {
        XCTAssertEqual(
            ComposerLayout.returnKeyAction(text: "hello", imageCount: 0,
                                           hasShift: false, sendInFlight: false),
            .send, "unmodified Enter with text must send")
    }

    func testShiftEnterAlwaysInsertsNewline() {
        XCTAssertEqual(
            ComposerLayout.returnKeyAction(text: "hello", imageCount: 0,
                                           hasShift: true, sendInFlight: false),
            .insertNewline, "Shift+Enter must never send, even with sendable content")
    }

    func testEnterOnEmptyComposerDoesNotSend() {
        XCTAssertEqual(
            ComposerLayout.returnKeyAction(text: "", imageCount: 0,
                                           hasShift: false, sendInFlight: false),
            .insertNewline, "Enter on an empty composer must not send")
    }

    func testEnterOnWhitespaceOnlyComposerDoesNotSend() {
        XCTAssertEqual(
            ComposerLayout.returnKeyAction(text: "   \n  ", imageCount: 0,
                                           hasShift: false, sendInFlight: false),
            .insertNewline, "whitespace-only is not sendable content")
    }

    func testEnterSendsWhenOnlyImagesAreAttached() {
        XCTAssertEqual(
            ComposerLayout.returnKeyAction(text: "", imageCount: 1,
                                           hasShift: false, sendInFlight: false),
            .send, "an attached image alone is sendable, matching the button")
    }

    func testEnterDoesNotSendWhileASendIsInFlight() {
        XCTAssertEqual(
            ComposerLayout.returnKeyAction(text: "hello", imageCount: 0,
                                           hasShift: false, sendInFlight: true),
            .insertNewline, "mirrors the button's !sendInFlight gate")
    }

    // MARK: - Controls — these fail if the fix is faked

    /// CONTROL A: Enter must agree with the send BUTTON on every input, never "always send".
    ///
    /// The cheap fake here is making Return unconditionally call send: every test above
    /// except the empty/whitespace ones would still pass. This sweeps the whole input
    /// matrix and pins `.send` to exactly `canSend && !sendInFlight`, so an unconditional
    /// send goes red on the first non-sendable row — which is the point.
    func testReturnKeyAgreesWithSendButtonAcrossTheMatrix() {
        let texts = ["", " ", "\n", "hi", "  hi  "]
        let imageCounts = [0, 1]
        let inFlights = [false, true]

        for text in texts {
            for images in imageCounts {
                for inFlight in inFlights {
                    let action = ComposerLayout.returnKeyAction(
                        text: text, imageCount: images, hasShift: false, sendInFlight: inFlight)
                    let buttonWouldBeEnabled = !inFlight && ComposerLayout.canSend(
                        text: text, imageCount: images, disabled: false)
                    XCTAssertEqual(
                        action == .send, buttonWouldBeEnabled,
                        "Enter and the send button disagreed for text=\(text.debugDescription) "
                        + "images=\(images) inFlight=\(inFlight): Enter said \(action), "
                        + "button enabled = \(buttonWouldBeEnabled)")
                }
            }
        }
    }

    /// CONTROL B: Shift+Enter must be a newline for EVERY input, including ones where
    /// the button is enabled. The fake this catches is a policy that only checks Shift
    /// after the sendability test, which would send on Shift+Enter with text present —
    /// exactly the behaviour the operator asked us to avoid.
    func testShiftEnterNeverSendsForAnyInput() {
        for text in ["", " ", "hi", "  hi  "] {
            for images in [0, 1] {
                for inFlight in [false, true] {
                    XCTAssertEqual(
                        ComposerLayout.returnKeyAction(text: text, imageCount: images,
                                                       hasShift: true, sendInFlight: inFlight),
                        .insertNewline,
                        "Shift+Enter sent for text=\(text.debugDescription) images=\(images)")
                }
            }
        }
    }
}
