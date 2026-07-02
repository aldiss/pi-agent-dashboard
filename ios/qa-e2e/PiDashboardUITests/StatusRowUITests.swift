import XCTest

/// STATUS-ROW LAYOUT — the status chip renders on its OWN full-width row inside the
/// card, NOT crammed into the name header (where a long status wrapped one-char-per-
/// line into a tall column) and clear of the top-trailing `+N` collapse badge. Guards
/// the card-layout fix that moved `StatusChip` onto a dedicated `HStack` row below the
/// name + model, with `lineLimit(1)` + `.truncationMode(.tail)` so a long status
/// truncates horizontally instead of wrapping.
///
/// Each test narrows the list to a SINGLE card with `list-search` so the app-level
/// `session-card-name` / `session-card-status` first-matches unambiguously belong to
/// the same card — then compares element frames (the structural, deterministic half).
/// The purely-visual "long status truncates, doesn't wrap" is a render property
/// XCUITest can't read off an element (the fixture statuses are short); the attached
/// screenshot is the artifact, and the single-line height bound is the behavioral proxy.
@MainActor
final class StatusRowUITests: PiDashboardUITestCase {

    /// Narrow to Cartographer (the canonical drivers card) so the first-match name +
    /// status belong to one card, and return them once both are on screen.
    private func isolateCartographerCard() -> (name: XCUIElement, status: XCUIElement) {
        launch()
        connectAndEnterList()
        let field = waitFor("list-search")
        field.tap()
        field.typeText("cart")
        _ = waitFor("session-card-fix-cartographer", 8)
        let name = waitFor("session-card-name", 6)
        let status = waitFor("session-card-status", 6)
        return (name, status)
    }

    /// The status chip sits on its OWN row BELOW the name — `status.minY >= name.maxY`
    /// (no vertical overlap with the name row). This is the core of the fix: the chip is
    /// no longer inline in the header.
    func testStatusChipRendersOnItsOwnRowBelowName() {
        let (name, status) = isolateCartographerCard()
        XCTAssertTrue(name.exists && status.exists, "both the name and the status chip render")

        let nameFrame = name.frame
        let statusFrame = status.frame
        XCTAssertGreaterThanOrEqual(statusFrame.minY, nameFrame.maxY,
            "the status chip starts at/below the name's bottom — its own row, not crammed in the header")
        attach("statusrow-own-row")
    }

    /// The chip stays a SINGLE bounded line — its height is within ~2× the name's line
    /// height, i.e. it did NOT wrap one-char-per-line into a tall column (the pre-fix
    /// symptom). Screenshot carries the visual truncation evidence.
    func testStatusChipIsSingleLineHeightBounded() {
        let (name, status) = isolateCartographerCard()
        let lineH = name.frame.height
        XCTAssertGreaterThan(lineH, 0, "name line height is measurable")
        XCTAssertLessThanOrEqual(status.frame.height, lineH * 2.2,
            "the status chip is a single bounded line (no one-char-per-line vertical wrap)")
        attach("statusrow-single-line")
    }

    /// The status row is clear of the top-trailing `+N` badge zone: it sits well below
    /// the card's top edge (where the collapse-count overlay lives), so a `+N` badge and
    /// the status chip never occupy the same region.
    func testStatusRowClearOfTopTrailingBadgeZone() {
        let (_, status) = isolateCartographerCard()
        let card = waitFor("session-card-fix-cartographer", 6)
        XCTAssertGreaterThan(status.frame.minY, card.frame.minY + 20,
            "the status row is below the top-trailing +N badge zone — no overlap")
        attach("statusrow-clear-of-badge")
    }
}
