import XCTest
import PiDashboardKit

/// TIER + DIRECTORY FOLDING (round 3 / round 3.1) — the PWA-parity collapsible section
/// model, now driven against the hermetic `UITestFixtures` set. Two foldable levels, both
/// via a tappable header chevron:
///   • DIRECTORY folders (`dir-group-<basename>`) fold the cards under one cwd. State
///     persists per cwd (`store.collapsedDirs` → `pi.dashboard.collapsedDirs`).
///   • TIER sections (`tier-section-<raw>`) fold a whole tier's groups. State persists per
///     tier rawValue (`store.tierFold` → `pi.dashboard.tierFold`) with the PWA default:
///     {standing-crew, drivers, cell-executor} EXPANDED, the rest COLLAPSED.
///
/// Subjects are DERIVED from `UITestFixtures.sessions` via the same `SessionGrouping` the
/// app uses (`groupByTier`), so a test targets the exact tier a fixture session lands in —
/// no hardcoded ids. Both fold sets persist to `UserDefaults`, so `launchCleanFold` forces
/// them EMPTY through the arg domain for a deterministic clean-default start; the
/// persistence test relaunches bare then restores the default so nothing leaks.
@MainActor
final class FoldingUITests: PiDashboardUITestCase {

    // MARK: TIER folding via the header chevron

    /// A default-EXPANDED tier that has fixture cards folds shut when its header is
    /// tapped: the a11y value flips expanded→collapsed AND its cards leave the tree;
    /// tapping again re-expands.
    func testTierSectionFoldsAndUnfoldsViaHeader() {
        launchCleanFold()
        connectAndEnterList()

        let (tier, cards) = foldableExpandedTier()
        let raw = tier.rawValue
        let header = waitFor("tier-section-\(raw)", 6)
        XCTAssertTrue(waitForTierValue(raw, "expanded"), "\(raw) is expanded by default")
        XCTAssertTrue(waitForAppear(cards[0], 6), "an expanded tier shows its cards")
        attach("folding-tier-expanded")

        header.tap()
        XCTAssertTrue(waitForTierValue(raw, "collapsed"), "tapping the header collapses the tier")
        for c in cards {
            XCTAssertTrue(waitForGone(c, 6), "a collapsed tier hides its card \(c)")
        }
        attach("folding-tier-collapsed")

        header.tap()
        XCTAssertTrue(waitForTierValue(raw, "expanded"), "tapping again re-expands the tier")
        XCTAssertTrue(waitForAppear(cards[0], 6), "re-expanding restores the cards")
    }

    /// The PWA default fold set: the default-EXPANDED tiers present in the fixture render
    /// expanded, and the default-COLLAPSED tiers present render collapsed, on a clean
    /// launch. Proves the default-collapsed tiers ship folded, not just that folding works.
    func testDefaultFoldStateMatchesPWASet() {
        launchCleanFold()
        connectAndEnterList()

        let expandedDefault: Set<SessionTier> = [.standingCrew, .drivers, .cellExecutor]
        let present = presentTiers()
        var assertedExpanded = false, assertedCollapsed = false

        for tier in present {
            let raw = tier.rawValue
            if expandedDefault.contains(tier) {
                XCTAssertTrue(waitForTierValue(raw, "expanded"), "\(raw) expanded by default (PWA set)")
                assertedExpanded = true
            } else {
                // Collapsed tiers sit lower — swipe them into the realized tree.
                XCTAssertTrue(swipeToReveal("tier-section-\(raw)"), "\(raw) header reachable")
                XCTAssertEqual(el("tier-section-\(raw)").value as? String, "collapsed",
                               "\(raw) collapsed by default (PWA set)")
                assertedCollapsed = true
            }
        }
        XCTAssertTrue(assertedExpanded, "the fixture covers ≥1 default-expanded tier")
        XCTAssertTrue(assertedCollapsed, "the fixture covers ≥1 default-collapsed tier")
        attach("folding-defaults")
    }

    // MARK: DIRECTORY folding via the header chevron

    /// Within a tier that spans ≥2 cwds, folding ONE directory folder hides only THAT
    /// folder's card; a sibling folder's card stays visible. Tapping again restores it.
    func testDirectoryFolderFoldsViaHeaderHidingOnlyItsCards() {
        launchCleanFold()
        connectAndEnterList()

        let (basename, foldedCard, siblingCard) = twoCwdTier()
        let header = waitFor("dir-group-\(basename)", 6)
        XCTAssertTrue(waitForAppear(foldedCard, 6), "the folder's card shows while expanded")
        XCTAssertTrue(exists(siblingCard), "the sibling folder's card is present too")
        attach("folding-dir-expanded")

        header.tap()
        XCTAssertTrue(waitForGone(foldedCard, 6), "folding the directory hides its card")
        XCTAssertTrue(exists(siblingCard), "a sibling directory folder is unaffected")
        attach("folding-dir-collapsed")

        header.tap()
        XCTAssertTrue(waitForAppear(foldedCard, 6), "unfolding the directory restores its card")
    }

    // MARK: persistence across relaunch

    /// A tier fold survives an app relaunch. Collapse a default-expanded tier, terminate,
    /// relaunch WITHOUT the fold-forcing args (so the on-disk value is read back), assert
    /// still collapsed — then restore the default so the persisted key is cleared.
    func testTierFoldPersistsAcrossRelaunch() {
        launchCleanFold()
        connectAndEnterList()
        let (tier, cards) = foldableExpandedTier()
        let raw = tier.rawValue
        XCTAssertTrue(waitForTierValue(raw, "expanded"), "clean baseline: \(raw) expanded")

        waitFor("tier-section-\(raw)", 6).tap()
        XCTAssertTrue(waitForTierValue(raw, "collapsed"), "\(raw) collapsed before relaunch")
        usleep(400_000) // let the didSet UserDefaults write settle
        app.terminate()

        launch(Self.fixtureArgs) // relaunch WITHOUT the fold force → reads the persisted set
        connectAndEnterList()
        XCTAssertTrue(waitForTierValue(raw, "collapsed"),
                      "the collapsed tier fold persisted across relaunch")
        XCTAssertTrue(waitForGone(cards[0], 6),
                      "the persisted-collapsed tier still hides its cards after relaunch")
        attach("folding-persisted-collapsed")

        waitFor("tier-section-\(raw)", 6).tap()
        XCTAssertTrue(waitForTierValue(raw, "expanded"), "restored to the expanded default")
    }

    // MARK: fixture-derived subjects

    /// A default-EXPANDED tier (standing-crew / drivers / cell-executor) that has fixture
    /// cards, plus its card ids. Fails clearly if the fixture covers none.
    private func foldableExpandedTier() -> (SessionTier, [String]) {
        let expandedDefault: [SessionTier] = [.drivers, .standingCrew, .cellExecutor]
        let grouped = SessionGrouping.groupByTier(fixtureSessions)
        for tier in expandedDefault {
            if let entry = grouped.first(where: { $0.tier == tier }), !entry.sessions.isEmpty {
                return (tier, entry.sessions.map { cardId($0) })
            }
        }
        XCTFail("UITestFixtures covers no default-expanded tier with cards (need standing-crew/drivers/cell-executor)")
        return (.drivers, [])
    }

    /// The tiers actually present in the fixture set (in the app's tier order).
    private func presentTiers() -> [SessionTier] {
        SessionGrouping.groupByTier(fixtureSessions).map { $0.tier }
    }

    /// A tier that spans ≥2 distinct cwds: returns (foldedBasename, its card id, a
    /// sibling-cwd card id). Fails clearly if no tier has two cwds.
    private func twoCwdTier() -> (String, String, String) {
        for entry in SessionGrouping.groupByTier(fixtureSessions) {
            let byCwd = Dictionary(grouping: entry.sessions) { $0.cwd ?? "" }
                .filter { !$0.key.isEmpty }
            if byCwd.count >= 2 {
                let cwds = byCwd.keys.sorted()
                let foldCwd = cwds[0], sibCwd = cwds[1]
                let basename = foldCwd.split(separator: "/").last.map(String.init) ?? foldCwd
                let foldedCard = cardId(byCwd[foldCwd]![0])
                let siblingCard = cardId(byCwd[sibCwd]![0])
                return (basename, foldedCard, siblingCard)
            }
        }
        XCTFail("UITestFixtures has no tier spanning ≥2 cwds (needed for directory folding)")
        return ("", "", "")
    }

    // MARK: helpers

    /// Launch fixture mode with BOTH persisted fold sets forced EMPTY through the arg
    /// domain — the clean PWA default fold state, deterministic regardless of a prior run.
    @discardableResult
    private func launchCleanFold(_ extra: [String] = []) -> XCUIApplication {
        launch(Self.fixtureArgs + ["-pi.dashboard.tierFold", "()",
                                   "-pi.dashboard.collapsedDirs", "()"] + extra)
    }

    /// Poll a tier header's accessibilityValue (`expanded`/`collapsed`) until it equals
    /// `expected`. Deadline poll (no self-capturing NSPredicate) — Swift 6 clean.
    @discardableResult
    private func waitForTierValue(_ raw: String, _ expected: String, _ timeout: TimeInterval = 6) -> Bool {
        let id = "tier-section-\(raw)"
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if (el(id).value as? String) == expected { return true }
            usleep(150_000)
        }
        return (el(id).value as? String) == expected
    }

    /// Swipe the list up until `id` is realized (LazyVStack de-realizes off-screen rows).
    @discardableResult
    private func swipeToReveal(_ id: String, _ maxSwipes: Int = 4) -> Bool {
        if el(id).exists { return true }
        let list = el("session-list")
        for _ in 0..<maxSwipes {
            list.swipeUp()
            if el(id).exists { return true }
        }
        return el(id).exists
    }
}
