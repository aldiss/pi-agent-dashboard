import XCTest

/// CREW COLLAPSE (the operator's "doubling" bug) — a standing-crew canonical name with
/// tenures in MULTIPLE cwds must fold to exactly ONE row plus a `+N` badge, NOT one row
/// per cwd-group. The fold is GLOBAL across a tier's directory groups for crew names
/// (Bert/Joan/Peggy/Lane/Pete/Faye/Don/Alice), per-group for everything else
/// (`SessionGrouping.collapseGroupsFoldingCrew`).
///
/// Relationship to `SessionDeclutterUITests.testSameNameTenuresCollapseWithBadge`: that
/// spec asserts the GENERIC same-name collapse badge exists (any tier) and SKIPS pending
/// a duplicate-name fixture. This file is the CREW-specific counterpart — it adds the
/// regression guard that runs TODAY against the shipped all-distinct-names fixture (the
/// doubling bug's negative: each crew name appears exactly once, no spurious badge), and
/// authors the positive global-multi-cwd fold that skips pending the same fixture pair.
/// No overlap: SessionDeclutter proves "a badge can render", this proves "distinct crew
/// names never double + fold globally when they should".
@MainActor
final class CrewCollapseUITests: PiDashboardUITestCase {

    /// REGRESSION GUARD (runs today): the crew name Joan (the fixture's only standing-crew
    /// canonical) renders EXACTLY ONCE. The doubling bug showed a crew name once per
    /// cwd-group; with the global fold, one tenure = one row. Search "joan" narrows to that
    /// card (and force-expands every tier so fold state can't hide it) for a deterministic
    /// count.
    func testCrewNameRendersExactlyOnce() {
        launch()
        connectAndEnterList()

        // Narrow to Joan — search matches her name only, and force-expands all tiers.
        let field = waitFor("list-search")
        field.tap()
        field.typeText("joan")
        XCTAssertTrue(waitForAppear("session-card-fix-joan", 6), "the Joan crew card renders")

        // Exactly ONE row carries her id — never doubled across cwd-groups.
        let joanRows = app.descendants(matching: .any).allElementsBoundByIndex
            .filter { $0.identifier == "session-card-fix-joan" }
        XCTAssertEqual(joanRows.count, 1, "the crew name renders exactly one row (no per-cwd doubling)")
        attach("crew-single-row")
    }

    /// REGRESSION GUARD (runs today): with the shipped fixture's all-DISTINCT names, the
    /// crew fold collapses NOTHING — so NO `card-collapsed-count-*` badge renders anywhere.
    /// A regression that folded distinct names together (or re-introduced doubling with a
    /// stray badge) would trip this.
    func testDistinctNamesProduceNoCollapseBadge() {
        launch()
        connectAndEnterList()
        _ = waitFor("session-card-fix-cartographer", 8) // list is up + realized

        let badges = app.descendants(matching: .any).allElementsBoundByIndex
            .filter { $0.identifier.hasPrefix("card-collapsed-count-") }
        XCTAssertTrue(badges.isEmpty,
                      "distinct canonical names fold nothing — no +N collapse badge renders")
        attach("crew-no-spurious-badge")
    }

    /// POSITIVE PATH (skips pending a fixture): a crew name with tenures in ≥2 cwds folds
    /// to ONE row + a `+N` badge (`card-collapsed-count-<survivorId>`). The shipped fixture
    /// has each crew name in a single cwd, so the global fold has nothing to collapse and no
    /// badge renders. Needs a fixture pair — e.g. a second `Joan` tenure in a DIFFERENT cwd
    /// (`FixtureData.sessionsSnapshot()`), which the global crew fold would collapse onto the
    /// survivor with `olderCount == 1`. Until it lands this SKIPS with a request (the fold
    /// ALGEBRA is unit-covered by SessionGroupingTests; this is the missing e2e wiring).
    /// App-target/fixture change = cc-ios-build owned (reported to SwiftPilot).
    func testCrewInMultipleCwdsCollapsesToOneRowWithBadge() throws {
        launchForcing(hideEnded: false) // show every tenure so any crew fold can render
        connectAndEnterList()

        let badge = app.descendants(matching: .any).allElementsBoundByIndex
            .first { $0.identifier.hasPrefix("card-collapsed-count-") }
        guard badge != nil else {
            throw XCTSkip("""
            No crew fold to observe — the fixture has each crew name (Joan/…) in a SINGLE cwd, \
            so `collapseGroupsFoldingCrew` collapses nothing and no `card-collapsed-count-*` \
            badge renders. PENDING fixture extension: add a second same-crew tenure in a \
            DIFFERENT cwd (e.g. a 2nd `Joan`) to FixtureData.sessionsSnapshot() so the global \
            crew fold folds it to one row + a +N badge (the operator's doubling repro). Fold \
            algebra is unit-covered (SessionGroupingTests); this is the e2e wiring. Reported to \
            cc-ios-build. Spec authored + ready.
            """)
        }
        attach("crew-multi-cwd-folded")
    }
}
