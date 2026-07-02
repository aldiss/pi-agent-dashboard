import XCTest
import PiDashboardKit

/// CREW COLLAPSE (the operator's "doubling" bug) — a standing-crew canonical name with
/// tenures in MULTIPLE cwds folds to exactly ONE row plus a `+N` badge, NOT one row per
/// cwd-group. The fold is GLOBAL across a tier's directory groups for crew names,
/// per-group for everything else (`SessionGrouping.collapseGroupsFoldingCrew`).
///
/// Contract fixture: `UITestFixtures` seeds the standing-crew name "Pete" with tenures in
/// TWO different cwds (`peteTenures()` returns both), so the global crew fold collapses
/// them to one row + "+1". The subject is derived from the fixture set (the Pete pair),
/// and the surviving row id is computed via the SAME `collapseGroupsFoldingCrew` the app
/// uses — so the test asserts on the exact `card-collapsed-count-<survivor>` badge.
@MainActor
final class CrewCollapseUITests: PiDashboardUITestCase {

    /// The contract holds at the fixture layer: Pete has ≥2 tenures across ≥2 cwds (so the
    /// global crew fold has something to fold). Guards the fixture set's coverage.
    func testFixtureHasPeteInTwoCwds() {
        let pete = peteTenures()
        XCTAssertGreaterThanOrEqual(pete.count, 2, "the fixture seeds ≥2 Pete tenures")
        let cwds = Set(pete.map { $0.cwd ?? "" })
        XCTAssertGreaterThanOrEqual(cwds.count, 2, "Pete's tenures span ≥2 distinct cwds")
    }

    /// Pete renders EXACTLY ONE row (the doubling bug showed one row per cwd-group). Search
    /// "Pete" narrows to his card(s) + force-expands every tier so fold state can't hide a
    /// row; exactly one `session-card-name` reads "Pete".
    func testCrewNameRendersExactlyOneRow() {
        launch()
        connectAndEnterList()

        let field = waitFor("list-search")
        field.tap()
        field.typeText("Pete")
        // At least one Pete card realizes.
        XCTAssertTrue(waitForAnyPeteCard(6), "a Pete crew card renders under the search")

        let peteNameRows = app.descendants(matching: .any).allElementsBoundByIndex
            .filter { $0.identifier == "session-card-name" && ($0.label == "Pete") }
        XCTAssertEqual(peteNameRows.count, 1,
                       "the crew name folds to exactly one row (no per-cwd doubling)")
        attach("crew-single-row")
    }

    /// The folded Pete row carries the `+N` collapse badge for its hidden tenures. The
    /// surviving row id is computed via `collapseGroupsFoldingCrew` (the app's own fold),
    /// so the exact `card-collapsed-count-<survivor>` id is asserted.
    func testFoldedCrewRowShowsCollapsedCountBadge() {
        launch()
        connectAndEnterList()
        let field = waitFor("list-search")
        field.tap()
        field.typeText("Pete")
        XCTAssertTrue(waitForAnyPeteCard(6), "a Pete card renders")

        if let survivor = foldedPeteSurvivorId() {
            XCTAssertTrue(waitForAppear("card-collapsed-count-\(survivor)", 6),
                          "the folded Pete row shows its +N collapse badge")
        } else {
            // Fallback (fold survivor not derivable from the pure helper): ANY collapse
            // badge on the Pete-narrowed list proves the fold rendered a +N.
            let hasBadge = app.descendants(matching: .any).allElementsBoundByIndex
                .contains { $0.identifier.hasPrefix("card-collapsed-count-") }
            XCTAssertTrue(hasBadge, "a +N collapse badge renders for the folded crew name")
        }
        attach("crew-collapse-badge")
    }

    // MARK: fixture-derived subjects

    /// The surviving row id for the folded Pete crew, computed by the app's own global
    /// crew fold over the standing-crew tier groups. nil if not derivable (→ fallback).
    private func foldedPeteSurvivorId() -> String? {
        let grouped = SessionGrouping.groupByTier(fixtureSessions)
        guard let crew = grouped.first(where: { $0.tier == .standingCrew }) else { return nil }
        let dirGroups = SessionGrouping.groupTierByFolder(
            crew.sessions, folders: true, orders: [:], pinnedDirectories: [])
        let collapsed = SessionGrouping.collapseGroupsFoldingCrew(dirGroups, selectedId: nil)
        for group in collapsed {
            for row in group.rows where row.session.name == "Pete" && row.olderCount > 0 {
                return row.session.id
            }
        }
        return nil
    }

    /// True once ANY of Pete's fixture card ids is on screen.
    private func waitForAnyPeteCard(_ timeout: TimeInterval) -> Bool {
        let ids = peteTenures().map { cardId($0) }
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if ids.contains(where: { el($0).exists }) { return true }
            usleep(150_000)
        }
        return ids.contains { el($0).exists }
    }
}
