import XCTest
import PiDashboardKit

/// COLOR CODING — the session-list "color language": a card carries ONE semantic hue on its
/// status rail + dot + status text, and an unread card swaps its left rail to the unread
/// stripe. XCUITest CANNOT read a rendered color off an element, so this asserts the
/// NON-COLOR signals that BACK the color language (the deterministic half) + attaches a
/// screenshot as the color artifact:
///   • the left-rail IDENTITY ternary — `session-card-unread` when the session has unviewed
///     activity, else the calm `card-status-rail`,
///   • the status chip's a11y VALUE = the raw status and LABEL = the spoken state word.
///
/// Subjects derived from `UITestFixtures`: an `unread == true` session (→ unread rail) and a
/// distinct non-unread session (→ calm rail); a `streaming` session for the status-word cue.
@MainActor
final class ColorCodingUITests: PiDashboardUITestCase {

    /// Narrow to `subject` by display name (force-expands tiers) + wait for its card.
    private func show(_ subject: DashboardSession) {
        launch()
        connectAndEnterList()
        let field = waitFor("list-search")
        field.tap()
        field.typeText(subject.displayName)
        _ = waitFor(cardId(subject), 8)
    }

    /// An UNREAD session carries the `session-card-unread` left rail (the unread stripe id).
    func testUnreadSessionCarriesUnreadRail() {
        let subject = fixtureSession("is unread") { $0.unread == true }
        show(subject)
        XCTAssertTrue(waitForAppear("session-card-unread", 6),
                      "an unread session exposes the unread rail stripe id")
        attach("color-unread-rail")
    }

    /// A NON-unread session carries the calm `card-status-rail` id, not the unread stripe.
    func testNonUnreadSessionCarriesCalmRail() {
        let subject = fixtureSession("is not unread") { $0.unread != true }
        show(subject)
        XCTAssertTrue(waitForAppear("card-status-rail", 6),
                      "a non-unread session exposes the calm status rail id")
        attach("color-calm-rail")
    }

    /// The status chip encodes state without color: its a11y value is the raw status and its
    /// label is the spoken word. A streaming session → value "streaming", label "Working".
    func testStatusChipCarriesNonColorStateSignal() {
        let subject = fixtureSession(status: "streaming")
        show(subject)
        let status = waitFor("session-card-status", 6)
        XCTAssertEqual(status.value as? String, "streaming",
                       "the status chip exposes the raw status as its value")
        XCTAssertTrue(status.label.contains("Working"),
                      "the spoken status label is the non-color cue for the working hue (got \(status.label))")
        attach("color-status-signal")
    }

    /// The rail-identity is state-driven: an unread session shows the unread rail and a
    /// non-unread session the calm rail — mutually exclusive across two cards.
    func testRailIdentityIsStateDriven() {
        let unread = fixtureSession("is unread") { $0.unread == true }
        let calm = fixtureSession("is not unread") { $0.unread != true }
        launch()
        connectAndEnterList()
        XCTAssertTrue(waitForAppear(cardId(unread), 8), "the unread card is present")
        XCTAssertTrue(exists(cardId(calm)) || waitForAppear(cardId(calm), 4), "the calm card is present")
        XCTAssertTrue(exists("session-card-unread"), "the unread session drives the unread rail")
        XCTAssertTrue(exists("card-status-rail"), "the calm session drives the calm rail")
        attach("color-rail-state-driven")
    }
}
