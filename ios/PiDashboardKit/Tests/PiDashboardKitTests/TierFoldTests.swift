import XCTest
@testable import PiDashboardKit

/// Round 3.1 — foldable TIER sections (Standing Crew / Drivers / Cell Executor / …),
/// mirroring the directory-fold pattern. The fold decision + persistence are pure
/// (`TierFold` + `ListPrefsStore`), verified here via `swift test`. Defaults match the
/// PWA `DEFAULT_EXPANDED_TIERS` ({standing-crew, drivers, cell-executor} expanded; the
/// rest collapsed — they flood the list).
final class TierFoldTests: XCTestCase {

    // MARK: defaults match the PWA

    func testDefaultExpandedTiersIsExactlyThePwaSet() {
        XCTAssertEqual(DEFAULT_EXPANDED_TIERS, [.standingCrew, .drivers, .cellExecutor])
        // and the other three are NOT in it (default-collapsed).
        for t in [SessionTier.operatorChatPane, .worker, .other] {
            XCTAssertFalse(DEFAULT_EXPANDED_TIERS.contains(t), "\(t) must default collapsed")
        }
    }

    /// Empty off-default set = clean defaults: the PWA-expanded trio is expanded, the
    /// flood-prone trio is collapsed.
    func testEmptySetResolvesToDefaults() {
        let none: Set<String> = []
        XCTAssertTrue(TierFold.isExpanded(.standingCrew, offDefault: none))
        XCTAssertTrue(TierFold.isExpanded(.drivers, offDefault: none))
        XCTAssertTrue(TierFold.isExpanded(.cellExecutor, offDefault: none))
        XCTAssertFalse(TierFold.isExpanded(.operatorChatPane, offDefault: none))
        XCTAssertFalse(TierFold.isExpanded(.worker, offDefault: none))
        XCTAssertFalse(TierFold.isExpanded(.other, offDefault: none))
    }

    // MARK: a single toggle inverts, from EITHER default side

    func testToggleInvertsDefaultExpandedTier() {
        // standing-crew starts expanded → one toggle collapses it (key becomes present).
        var set: Set<String> = []
        XCTAssertTrue(TierFold.isExpanded(.standingCrew, offDefault: set))
        set = TierFold.toggle(.standingCrew, in: set)
        XCTAssertTrue(set.contains("standing-crew"), "flipped away from default → key present")
        XCTAssertFalse(TierFold.isExpanded(.standingCrew, offDefault: set))
        // toggle back → expanded again, set empties.
        set = TierFold.toggle(.standingCrew, in: set)
        XCTAssertFalse(set.contains("standing-crew"))
        XCTAssertTrue(TierFold.isExpanded(.standingCrew, offDefault: set))
    }

    func testToggleInvertsDefaultCollapsedTier() {
        // worker starts collapsed → one toggle expands it (key becomes present).
        var set: Set<String> = []
        XCTAssertFalse(TierFold.isExpanded(.worker, offDefault: set))
        set = TierFold.toggle(.worker, in: set)
        XCTAssertTrue(set.contains("worker"), "flipped away from default → key present")
        XCTAssertTrue(TierFold.isExpanded(.worker, offDefault: set))
        // toggle back → collapsed again.
        set = TierFold.toggle(.worker, in: set)
        XCTAssertFalse(TierFold.isExpanded(.worker, offDefault: set))
    }

    // MARK: force-expand (active search) overrides EVERY tier

    func testForceExpandOverridesAllTiers() {
        // Even a normally-collapsed tier, and even one explicitly folded shut, expands
        // while searching — a collapsed tier must never hide a match.
        let folded: Set<String> = ["standing-crew"] // standing-crew explicitly collapsed
        XCTAssertFalse(TierFold.isExpanded(.standingCrew, offDefault: folded))               // without search
        XCTAssertTrue(TierFold.isExpanded(.standingCrew, offDefault: folded, forceExpand: true))
        XCTAssertTrue(TierFold.isExpanded(.worker, offDefault: [], forceExpand: true))
        XCTAssertTrue(TierFold.isExpanded(.other, offDefault: [], forceExpand: true))
    }

    // MARK: persistence round-trip (ephemeral UserDefaults)

    private func ephemeral() -> (UserDefaults, String) {
        let suite = "pi.dashboard.tierfold.tests.\(UUID().uuidString)"
        return (UserDefaults(suiteName: suite)!, suite)
    }

    func testTierFoldDefaultsEmpty() {
        let (d, suite) = ephemeral()
        defer { d.removePersistentDomain(forName: suite) }
        XCTAssertTrue(ListPrefsStore.loadTierFold(from: d).isEmpty, "fresh install → clean defaults")
    }

    func testTierFoldRoundTrips() {
        let (d, suite) = ephemeral()
        defer { d.removePersistentDomain(forName: suite) }
        let set: Set<String> = ["worker", "standing-crew"]
        ListPrefsStore.saveTierFold(set, to: d)
        XCTAssertEqual(ListPrefsStore.loadTierFold(from: d), set, "off-default set survives relaunch")
        // Emptying clears the key → fresh read resolves back to clean defaults.
        ListPrefsStore.saveTierFold([], to: d)
        XCTAssertTrue(ListPrefsStore.loadTierFold(from: d).isEmpty)
    }

    /// End-to-end via the persistence layer: fold `worker` open, reload, and confirm it
    /// resolves expanded — the operator's choice survives a relaunch.
    func testPersistedToggleSurvivesReload() {
        let (d, suite) = ephemeral()
        defer { d.removePersistentDomain(forName: suite) }
        let toggled = TierFold.toggle(.worker, in: ListPrefsStore.loadTierFold(from: d))
        ListPrefsStore.saveTierFold(toggled, to: d)
        let reloaded = ListPrefsStore.loadTierFold(from: d)
        XCTAssertTrue(TierFold.isExpanded(.worker, offDefault: reloaded), "worker stays expanded after reload")
        XCTAssertTrue(TierFold.isExpanded(.standingCrew, offDefault: reloaded), "untouched tier keeps its default")
    }
}
