import XCTest
import PiDashboardKit

/// STATUS-ROW LAYOUT — the status chip renders on its OWN full-width row inside the card,
/// NOT crammed into the name header (where a long status wrapped one-char-per-line), and
/// clear of the top-trailing `+N` collapse badge. Guards the card-layout fix that moved
/// `StatusChip` onto a dedicated row below the name + model, with `lineLimit(1)` +
/// `.truncationMode(.tail)`.
///
/// Subject derived from `UITestFixtures`: a session with a non-empty status (the contract
/// seeds a longish status to prove truncation). Narrowed to a single card so the app-level
/// `session-card-name` / `session-card-status` first-matches belong to the same card, then
/// compares element frames (the structural, deterministic half); the visual "long status
/// truncates, doesn't wrap" is a render property the screenshot carries.
@MainActor
final class StatusRowUITests: PiDashboardUITestCase {

    /// A fixture session whose status chip is on screen — narrowed to one card via its
    /// display name — returning its name + status elements.
    private func isolateStatusCard() -> (name: XCUIElement, status: XCUIElement, card: String) {
        launch()
        connectAndEnterList()
        let subject = fixtureSession("has a status") { ($0.status?.isEmpty == false) }
        let field = waitFor("list-search")
        field.tap()
        field.typeText(subject.displayName)
        let card = cardId(subject)
        _ = waitFor(card, 6)
        let name = waitFor("session-card-name", 6)
        let status = waitFor("session-card-status", 6)
        return (name, status, card)
    }

    /// The status chip sits on its OWN row BELOW the name — `status.minY >= name.maxY`.
    func testStatusChipRendersOnItsOwnRowBelowName() {
        let (name, status, _) = isolateStatusCard()
        XCTAssertTrue(name.exists && status.exists, "both the name and the status chip render")
        XCTAssertGreaterThanOrEqual(status.frame.minY, name.frame.maxY,
            "the status chip starts at/below the name's bottom — its own row, not the header")
        attach("statusrow-own-row")
    }

    /// The chip stays a SINGLE bounded line — height within ~2× the name's line height
    /// (no one-char-per-line vertical wrap). Screenshot carries the visual truncation.
    func testStatusChipIsSingleLineHeightBounded() {
        let (name, status, _) = isolateStatusCard()
        let lineH = name.frame.height
        XCTAssertGreaterThan(lineH, 0, "name line height is measurable")
        XCTAssertLessThanOrEqual(status.frame.height, lineH * 2.2,
            "the status chip is a single bounded line (no vertical wrap)")
        attach("statusrow-single-line")
    }

    /// The status row is clear of the top-trailing `+N` badge zone (below the card top).
    func testStatusRowClearOfTopTrailingBadgeZone() {
        let (_, status, cardId) = isolateStatusCard()
        let card = waitFor(cardId, 6)
        XCTAssertGreaterThan(status.frame.minY, card.frame.minY + 20,
            "the status row is below the top-trailing +N badge zone — no overlap")
        attach("statusrow-clear-of-badge")
    }
}
