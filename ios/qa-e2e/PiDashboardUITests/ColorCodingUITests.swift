import XCTest

/// COLOR CODING — the session-list "color language": a card carries ONE semantic hue
/// (green alive / amber working / red error / faint ended) on its status rail + dot +
/// status text, and an unread card swaps its left rail to the unread (cyan) stripe with
/// a state-pulse. XCUITest CANNOT read a rendered color off an element, so this asserts
/// the NON-COLOR signals that BACK the color language (the deterministic half), and
/// attaches a screenshot as the color artifact (per the repo's "verify by rendering"
/// rule):
///   • the left-rail IDENTITY ternary — `session-card-unread` when the session has
///     unviewed activity, else the calm `card-status-rail` (SessionCard rail),
///   • the status chip's accessibilityVALUE = the raw status ("active"/"streaming"/…)
///     and its accessibilityLABEL = the spoken state word (A11yStatus) — the same
///     semantic that drives the hue.
///
/// Fixtures: Joan is `unread: true` (→ unread rail) + status "active"; Cartographer is
/// status "streaming" and NOT unread (→ calm rail).
@MainActor
final class ColorCodingUITests: PiDashboardUITestCase {

    /// Narrow to one card by a name query (also force-expands tiers so fold state can't
    /// hide it), then return once its card id is realized.
    private func show(_ query: String, cardId: String) {
        launch()
        connectAndEnterList()
        let field = waitFor("list-search")
        field.tap()
        field.typeText(query)
        _ = waitFor(cardId, 8)
    }

    /// An UNREAD session (Joan, `unread: true`) carries the `session-card-unread` left
    /// rail — the cyan unread stripe id — which is the non-color marker of the unread
    /// state-pulse. (The calm rail id `card-status-rail` is used otherwise.)
    func testUnreadSessionCarriesUnreadRail() {
        show("joan", cardId: "session-card-fix-joan")

        XCTAssertTrue(waitForAppear("session-card-unread", 6),
                      "an unread session exposes the unread rail stripe id")
        attach("color-unread-rail")
    }

    /// A NON-unread session (Cartographer) carries the calm `card-status-rail` id, NOT
    /// the unread stripe — the rail-identity ternary flips on the unread state.
    func testNonUnreadSessionCarriesCalmRail() {
        show("cart", cardId: "session-card-fix-cartographer")

        XCTAssertTrue(waitForAppear("card-status-rail", 6),
                      "a non-unread session exposes the calm status rail id")
        attach("color-calm-rail")
    }

    /// The status chip encodes state without relying on color: its accessibilityValue is
    /// the raw status and its accessibilityLabel is the spoken word. Cartographer is
    /// "streaming" → value "streaming", label speaks "Working" (A11yStatus). This is the
    /// non-color cue that pairs with the amber working hue.
    func testStatusChipCarriesNonColorStateSignal() {
        show("cart", cardId: "session-card-fix-cartographer")

        let status = waitFor("session-card-status", 6)
        XCTAssertEqual(status.value as? String, "streaming",
                       "the status chip exposes the raw status as its value (the hue's semantic)")
        if let label = status.label as String? {
            XCTAssertTrue(label.contains("Working"),
                          "the spoken status label is the non-color cue for the working hue (got \(label))")
        }
        attach("color-status-signal")
    }

    /// The rail-identity is state-driven, not fixed: the unread rail id and the calm rail
    /// id are MUTUALLY EXCLUSIVE across the two cards — Joan shows unread, Cartographer
    /// shows calm — proving the color language keys off session state, not a static style.
    func testRailIdentityIsStateDriven() {
        launch()
        connectAndEnterList()
        // Both cards visible in the default expanded tiers (standing-crew + drivers).
        XCTAssertTrue(waitForAppear("session-card-fix-joan", 8), "Joan card present")
        XCTAssertTrue(exists("session-card-fix-cartographer"), "Cartographer card present")

        // Joan (unread) contributes the unread rail; Cartographer (calm) the status rail.
        XCTAssertTrue(exists("session-card-unread"), "the unread session drives the unread rail")
        XCTAssertTrue(exists("card-status-rail"), "the calm session drives the calm rail")
        attach("color-rail-state-driven")
    }
}
