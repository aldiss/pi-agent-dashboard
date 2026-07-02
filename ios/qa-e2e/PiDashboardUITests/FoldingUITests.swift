import XCTest

/// TIER + DIRECTORY FOLDING (round 3 / round 3.1) — the PWA-parity collapsible
/// section model. Two foldable levels, both driven by a tappable header chevron:
///   • DIRECTORY folders (`dir-group-<basename>`) fold the session cards under one cwd.
///     State persists per cwd (`store.collapsedDirs` → `pi.dashboard.collapsedDirs`).
///   • TIER sections (`tier-section-<raw>`) fold a whole tier's groups. State persists
///     per tier rawValue (`store.tierFold` → `pi.dashboard.tierFold`) with the PWA
///     default set: {standing-crew, drivers, cell-executor} EXPANDED, the rest
///     ({operator-chat-pane, worker, other}) COLLAPSED.
///
/// Determinism: both fold sets persist to `UserDefaults`, so a prior run's toggles
/// would leak into a bare launch. `launchCleanFold` forces BOTH persisted sets EMPTY
/// through the `UserDefaults` argument domain (the same volatile, highest-precedence,
/// never-written-to-disk technique `launchForcing` uses for `hideEnded`/`themeMode`) —
/// so every test starts from the clean PWA default fold state, with no app-side hook.
/// The persistence test deliberately relaunches WITHOUT the force to read the on-disk
/// value back, then restores the default so it never leaks into a sibling.
@MainActor
final class FoldingUITests: PiDashboardUITestCase {

    // MARK: TIER folding via the header chevron

    /// A default-EXPANDED tier (drivers — Cartographer + Keystone live under
    /// `nos-cells/*-driver`) folds shut when its header is tapped: the a11y value flips
    /// expanded→collapsed AND its cards leave the tree; tapping again re-expands.
    func testTierSectionFoldsAndUnfoldsViaHeader() {
        launchCleanFold()
        connectAndEnterList()

        let drivers = waitFor("tier-section-drivers", 8)
        XCTAssertTrue(waitForTierValue("drivers", "expanded"),
                      "drivers is expanded by default (PWA default set)")
        XCTAssertTrue(waitForAppear("session-card-fix-cartographer", 6),
                      "an expanded tier shows its cards")
        attach("folding-tier-expanded")

        // Fold shut → value flips + the tier's cards drop out.
        drivers.tap()
        XCTAssertTrue(waitForTierValue("drivers", "collapsed"), "tapping the header collapses the tier")
        XCTAssertTrue(waitForGone("session-card-fix-cartographer", 6),
                      "a collapsed tier hides its cards")
        XCTAssertTrue(waitForGone("session-card-fix-keystone", 6),
                      "the tier's other card is hidden too")
        attach("folding-tier-collapsed")

        // Unfold → cards return (restores the default so nothing leaks).
        drivers.tap()
        XCTAssertTrue(waitForTierValue("drivers", "expanded"), "tapping again re-expands the tier")
        XCTAssertTrue(waitForAppear("session-card-fix-cartographer", 6), "re-expanding restores the cards")
    }

    /// The PWA default fold set: {standing-crew, drivers, cell-executor} expanded and
    /// {operator-chat-pane, other} collapsed on a clean launch (worker is ended → hidden
    /// by the default `hideEnded`, so it's not asserted here). Proves the default-collapsed
    /// tiers ship folded, not just that folding works.
    func testDefaultCollapsedTiersMatchPWASet() {
        launchCleanFold()
        connectAndEnterList()

        // Expanded-by-default trio (top of the list — no scroll needed).
        XCTAssertTrue(waitForTierValue("standing-crew", "expanded"), "standing-crew expanded by default")
        XCTAssertTrue(waitForTierValue("drivers", "expanded"), "drivers expanded by default")
        XCTAssertTrue(waitForTierValue("cell-executor", "expanded"), "cell-executor expanded by default")
        attach("folding-defaults-top")

        // Collapsed-by-default tiers sit lower — swipe them into the realized tree, then
        // assert they shipped folded.
        XCTAssertTrue(swipeToReveal("tier-section-operator-chat-pane"),
                      "the operator-chat-pane header is reachable")
        XCTAssertEqual(el("tier-section-operator-chat-pane").value as? String, "collapsed",
                       "operator-chat-pane is collapsed by default (PWA set)")
        XCTAssertTrue(swipeToReveal("tier-section-other"), "the other header is reachable")
        XCTAssertEqual(el("tier-section-other").value as? String, "collapsed",
                       "other is collapsed by default (PWA set)")
        attach("folding-defaults-collapsed")
    }

    // MARK: DIRECTORY folding via the header chevron

    /// Within the drivers tier, folding ONE directory folder
    /// (`dir-group-arch-diagram-driver` → Cartographer) hides only THAT folder's cards;
    /// the sibling folder (`auth-build-driver` → Keystone) stays visible. Tapping again
    /// restores it. Folders default ON, so the per-cwd headers render.
    func testDirectoryFolderFoldsViaHeaderHidingOnlyItsCards() {
        launchCleanFold()
        connectAndEnterList()

        let archFolder = waitFor("dir-group-arch-diagram-driver", 8)
        XCTAssertTrue(waitForAppear("session-card-fix-cartographer", 6),
                      "the folder's card shows while expanded")
        XCTAssertTrue(exists("session-card-fix-keystone"), "the sibling folder's card is present too")
        attach("folding-dir-expanded")

        // Fold the arch-diagram-driver folder → Cartographer hides, Keystone stays.
        archFolder.tap()
        XCTAssertTrue(waitForGone("session-card-fix-cartographer", 6),
                      "folding the directory hides its card")
        XCTAssertTrue(exists("session-card-fix-keystone"),
                      "a sibling directory folder is unaffected by the fold")
        attach("folding-dir-collapsed")

        // Unfold → the card returns (restore).
        archFolder.tap()
        XCTAssertTrue(waitForAppear("session-card-fix-cartographer", 6),
                      "unfolding the directory restores its card")
    }

    // MARK: persistence across relaunch

    /// A tier fold survives an app relaunch (persisted to `pi.dashboard.tierFold`).
    /// Collapse drivers, terminate, relaunch WITHOUT the fold-forcing args (so the
    /// on-disk value is read back), and assert drivers is STILL collapsed — then restore
    /// the default so the persisted key is cleared for sibling tests.
    func testTierFoldPersistsAcrossRelaunch() {
        launchCleanFold()
        connectAndEnterList()
        XCTAssertTrue(waitForTierValue("drivers", "expanded"), "clean baseline: drivers expanded")

        // Collapse it → writes {"drivers"} to the persistent domain.
        waitFor("tier-section-drivers", 8).tap()
        XCTAssertTrue(waitForTierValue("drivers", "collapsed"), "drivers collapsed before relaunch")
        // Let the didSet UserDefaults write settle before tearing the process down.
        usleep(400_000)
        app.terminate()

        // Relaunch WITHOUT the fold force → the store reads the PERSISTED off-default set.
        launch(["-uitest"])
        connectAndEnterList()
        XCTAssertTrue(waitForTierValue("drivers", "collapsed"),
                      "the collapsed tier fold persisted across relaunch")
        XCTAssertTrue(waitForGone("session-card-fix-cartographer", 6),
                      "the persisted-collapsed tier still hides its cards after relaunch")
        attach("folding-persisted-collapsed")

        // Restore the default (clears the persisted key) so this never leaks downstream.
        waitFor("tier-section-drivers", 8).tap()
        XCTAssertTrue(waitForTierValue("drivers", "expanded"), "restored to the expanded default")
    }

    // MARK: helpers

    /// Launch `-uitest` with BOTH persisted fold sets forced EMPTY through the
    /// `UserDefaults` argument domain — the clean PWA default fold state, deterministic
    /// regardless of a prior run's toggles (arg-domain values are highest-precedence on
    /// read + volatile, never written to disk). `()` is the old-style plist empty array.
    @discardableResult
    private func launchCleanFold(_ extra: [String] = []) -> XCUIApplication {
        launch(["-uitest",
                "-pi.dashboard.tierFold", "()",
                "-pi.dashboard.collapsedDirs", "()"] + extra)
    }

    /// Poll a tier header's accessibilityValue (`expanded`/`collapsed`) until it equals
    /// `expected`. SwiftUI posts the value asynchronously after a toggle. Deadline poll
    /// (no self-capturing NSPredicate) — Swift 6 strict-concurrency clean.
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

    /// Swipe the list up until `id` is realized into the tree (LazyVStack de-realizes
    /// off-screen rows). Returns true once it exists, false if still absent after N swipes.
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
