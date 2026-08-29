import XCTest

/// Render-level guard for the tier/row correspondence defect.
///
/// The pure `CrewCollapseTests` prove no two tier sections can emit the same
/// row-group identity. They cannot prove what the operator actually sees,
/// because the defect lived in SwiftUI's identity handling rather than in the
/// grouping functions — the full unit suite was green while the device showed
/// "Standing Crew 10" with DiskCleanup-3, Atlas-4, Portico-5 and Hearth-19
/// underneath it.
///
/// This asserts the on-screen relationship directly: a card belongs to the
/// nearest tier header ABOVE it, which is exactly how a reader interprets the
/// list. Assertions are made on frame geometry, not on the view tree, so a
/// regression that renders correct counts under the wrong header still fails.
///
/// Folders is switched OFF deliberately. That is the operator's reported
/// trigger and the worst case for the old bug: every group's cwd becomes "",
/// so every tier's row-group collided on the same identity at once.
@MainActor
final class TierRowCorrespondenceUITests: PiDashboardUITestCase {

    /// Fixture name → the tier its card must render under.
    private let expectedTier: [String: String] = [
        "Pete": "standing-crew",
        "Cartographer": "drivers",
        "Keystone": "drivers",
    ]

    func testCardsRenderUnderTheirOwnTierHeaderWithFoldersOff() {
        launch()
        connectAndEnterList()

        // Folders defaults ON; turn it OFF to force every cwd to "".
        let folders = waitFor("toggle-folders")
        if folders.value as? String == "on" { folders.tap() }

        // Expand every tier so rows are actually realized.
        for tier in ["standing-crew", "drivers", "other"] {
            let header = app.descendants(matching: .any).allElementsBoundByIndex
                .first { $0.identifier == "tier-section-\(tier)" }
            if let header, header.value as? String == "collapsed" { header.tap() }
        }

        let all = app.descendants(matching: .any).allElementsBoundByIndex
        let headers = all
            .filter { $0.identifier.hasPrefix("tier-section-") && $0.frame.height > 0 }
            .map { (tier: String($0.identifier.dropFirst("tier-section-".count)), y: $0.frame.minY) }
            .sorted { $0.y < $1.y }
        XCTAssertGreaterThanOrEqual(headers.count, 2,
            "need at least two tier sections on screen for this to mean anything")

        let cards = all
            .filter { $0.identifier == "session-card-name" && $0.frame.height > 0 }
            .map { (name: $0.label, y: $0.frame.minY) }
        XCTAssertFalse(cards.isEmpty, "at least one session card must render")

        var checked = 0
        for card in cards {
            guard let want = expectedTier[card.name] else { continue }
            guard let owning = headers.last(where: { $0.y < card.y })?.tier else { continue }
            checked += 1
            XCTAssertEqual(owning, want,
                "card \"\(card.name)\" renders under \"\(owning)\" but belongs to \"\(want)\"")
        }
        XCTAssertGreaterThan(checked, 0,
            "no known fixture card was matched — the check would pass vacuously")
        attach("tier-row-correspondence-folders-off")
    }
}
