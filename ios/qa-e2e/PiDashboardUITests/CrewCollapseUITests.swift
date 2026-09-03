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
        let expectedCards: Set<String> = [
            "session-card-\(UITestFixtures.peteId)",
            "session-card-\(UITestFixtures.peteSecondId)",
        ]
        let expectedLabels = [
            "card-directory-label-\(UITestFixtures.peteId)": "orchestration-state",
            "card-directory-label-\(UITestFixtures.peteSecondId)": "unend-e2e-cwd",
        ]
        let observed = scanPeteRows(labelIDs: Set(expectedLabels.keys))

        XCTAssertEqual(observed.cards, expectedCards,
                       "Pete renders once in each cwd; the same-cwd older tenure stays folded")
        XCTAssertEqual(observed.labels, expectedLabels,
                       "the two Pete rows show distinct, non-empty directory basenames")
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

        if let survivor = foldedPeteSurvivorId() {
            _ = scrollToHittable("card-collapsed-toggle-\(survivor)")
            XCTAssertTrue(el("card-collapsed-count-\(survivor)").exists,
                          "the folded Pete row keeps its +N collapse marker")
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

        let hiddenCard = cardId(hidden)
        XCTAssertFalse(el(hiddenCard).exists, "the older tenure starts folded")
        let toggleID = "card-collapsed-toggle-\(folded.session.id)"
        let toggle = scrollToHittable(toggleID)
        XCTAssertEqual(toggle.value as? String, "collapsed")
        toggle.tap()
        XCTAssertTrue(waitForValue(toggleID, equals: "expanded"), "the toggle reports expansion")
        let hiddenElement = scrollToHittable(hiddenCard)
        XCTAssertTrue(hiddenElement.exists, "tapping +N reveals the exact hidden tenure")

        hiddenElement.tap()
        _ = waitFor("chat-scroll", 6)
        _ = waitFor("mobile-composer", 6)
        XCTAssertEqual(waitFor("chat-model-button", 6).label, "Model: claude-sonnet-4",
                       "the revealed older tenure, not the Opus survivor, opened")
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

    private func scanPeteRows(labelIDs: Set<String>)
        -> (cards: Set<String>, labels: [String: String]) {
        let peteCardIDs = Set(peteTenures().map { cardId($0) })
        var cards: Set<String> = []
        var labels: [String: String] = [:]
        let list = el("session-list")

        for _ in 0..<6 {
            cards.formUnion(peteCardIDs.filter { el($0).exists })
            for id in labelIDs where el(id).exists {
                labels[id] = el(id).label
            }
            list.swipeUp()
        }
        return (cards, labels)
    }

    private func scrollToHittable(_ id: String) -> XCUIElement {
        let list = el("session-list")
        for _ in 0..<6 {
            let element = el(id)
            if element.exists, element.isHittable { return element }
            list.swipeUp()
        }
        let element = waitFor(id, 6)
        XCTAssertTrue(element.isHittable, "expected element '\(id)' to be hittable")
        return element
    }
}
