import XCTest
import PiDashboardKit

/// CREW COLLAPSE — repeated standing-crew tenures fold within one directory, while the
/// same crew name in another directory remains a separately reachable row.
///
/// Contract fixture: `UITestFixtures` seeds the standing-crew name "Pete" with tenures in
/// two sessions in cwd A and one in cwd B. The cwd-A pair collapses to one row + "+1";
/// cwd B remains visible. Subjects derive from the shared fixture and production helpers.
@MainActor
final class CrewCollapseUITests: PiDashboardUITestCase {

    /// The contract holds at the fixture layer: Pete spans two cwds and repeats in one.
    func testFixtureHasPeteInTwoCwdsWithSameCwdPair() {
        let pete = peteTenures()
        XCTAssertEqual(pete.count, 3, "the fixture seeds three Pete tenures")
        let cwds = Set(pete.map { $0.cwd ?? "" })
        XCTAssertEqual(cwds.count, 2, "Pete's tenures span two distinct cwds")
        XCTAssertTrue(Dictionary(grouping: pete, by: { $0.cwd ?? "" }).values.contains { $0.count == 2 },
                      "one cwd contains a foldable Pete pair")
    }

    /// Pete renders one row per cwd. Both rows carry a directory subtitle so they are not
    /// visually identical when the operator searches across folders.
    func testCrewNameRendersExactlyTwoDisambiguatedRows() {
        launchForcing(hideEnded: false)
        connectAndEnterList()

        let field = waitFor("list-search")
        field.tap()
        field.typeText("Pete")
        // At least one Pete card realizes.
        XCTAssertTrue(waitForAnyPeteCard(6), "a Pete crew card renders under the search")

        let peteNameRows = app.descendants(matching: .any).allElementsBoundByIndex
            .filter { $0.identifier == "session-card-name" && ($0.label == "Pete") }
        XCTAssertEqual(peteNameRows.count, 2, "Pete renders once in each cwd")
        XCTAssertTrue(waitForAppear("card-directory-label-\(UITestFixtures.peteId)", 6))
        XCTAssertTrue(waitForAppear("card-directory-label-\(UITestFixtures.peteSecondId)", 6))
        attach("crew-directory-rows")
    }

    /// The folded Pete row carries the `+N` collapse badge for its hidden tenures. The
    /// surviving row id is computed via `collapseGroups` (the app's own fold),
    /// so the exact `card-collapsed-count-<survivor>` id is asserted.
    func testFoldedCrewRowShowsCollapsedCountBadge() {
        // The same-cwd older Pete is ended, so force hideEnded OFF before exercising the fold.
        launchForcing(hideEnded: false)
        connectAndEnterList()
        let field = waitFor("list-search")
        field.tap()
        field.typeText("Pete")
        XCTAssertTrue(waitForAnyPeteCard(6), "a Pete card renders")

        if let survivor = foldedPeteSurvivorId() {
            XCTAssertTrue(waitForAppear("card-collapsed-count-\(survivor)", 6),
                          "the folded Pete row shows its +N collapse badge")
        } else {
            XCTFail("the same-cwd Pete fold survivor must be derivable from the fixture")
        }
        attach("crew-collapse-badge")
    }

    /// Interaction control: the badge must reveal the exact tenure behind `+N`, then that
    /// revealed card must open. A decorative or no-op "button" fails before navigation.
    func testCollapsedBadgeTapRevealsAndOpensHiddenTenure() {
        guard let folded = foldedPeteRow() else {
            XCTFail("the same-cwd Pete fold row must be derivable from the fixture")
            return
        }
        let registry = Dictionary(uniqueKeysWithValues: fixtureSessions.map { ($0.id, $0) })
        guard let hidden = SessionGrouping.foldedSessions(folded, registry: registry).first else {
            XCTFail("the Pete +N must resolve to a hidden tenure")
            return
        }
        XCTAssertEqual(hidden.id, UITestFixtures.peteSameCwdId)
        XCTAssertEqual(SessionGrouping.groupPath(hidden), SessionGrouping.groupPath(folded.session))

        launchForcing(hideEnded: false)
        connectAndEnterList()
        let field = waitFor("list-search")
        field.tap()
        field.typeText("Pete")
        XCTAssertTrue(waitForAnyPeteCard(6), "a Pete card renders")

        let hiddenCard = cardId(hidden)
        XCTAssertFalse(el(hiddenCard).exists, "the older tenure starts folded")
        let toggleID = "card-collapsed-toggle-\(folded.session.id)"
        let toggle = waitFor(toggleID)
        XCTAssertEqual(toggle.value as? String, "collapsed")
        toggle.tap()
        XCTAssertTrue(waitForValue(toggleID, equals: "expanded"), "the toggle reports expansion")
        XCTAssertTrue(waitForAppear(hiddenCard, 6), "tapping +N reveals the exact hidden tenure")

        openChat(cardId: hiddenCard)
    }

    // MARK: fixture-derived subjects

    /// The surviving row id for the same-cwd Pete pair, computed by the app's own fold.
    private func foldedPeteSurvivorId() -> String? {
        foldedPeteRow()?.session.id
    }

    private func foldedPeteRow() -> SessionGrouping.CollapsedSession? {
        let grouped = SessionGrouping.groupByTier(fixtureSessions)
        guard let crew = grouped.first(where: { $0.tier == .standingCrew }) else { return nil }
        let dirGroups = SessionGrouping.groupTierByFolder(
            crew.sessions, folders: true, orders: UITestFixtures.orders,
            pinnedDirectories: UITestFixtures.pinned)
        let collapsed = SessionGrouping.collapseGroups(dirGroups, selectedId: nil)
        for group in collapsed {
            for row in group.rows where row.olderIds.contains(UITestFixtures.peteSameCwdId) {
                return row
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
