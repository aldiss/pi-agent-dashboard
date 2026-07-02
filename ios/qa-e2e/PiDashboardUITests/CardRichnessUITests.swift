import XCTest

/// CARD RICHNESS (B4) — a session card surfaces its rich metadata when the session has
/// it: the context-usage bar (`session-card-context-bar`), a git branch badge
/// (`card-git-branch`) + PR badge (`card-git-pr`), token/cost stats (`card-tokens` /
/// `card-cost`), and a capped process list (`card-process-list`, ≤3 rows + "+N more").
/// Each element renders ONLY when the session carries that data, so this is a
/// data-driven render contract.
///
/// Fixture reality (`FixtureData.sessionsSnapshot`): Cartographer carries
/// `contextTokens`/`contextWindow` (→ context bar) + `gitBranch` (→ branch badge) +
/// `progress`/`nextEngagement` (→ driver row). It does NOT carry `processes`,
/// `tokensIn`/`tokensOut`, `cost`, or `gitPrNumber` — so those cards can't render. The
/// present-in-fixture richness is asserted TODAY; the absent-data cards are authored and
/// SKIP with a request to seed that fixture data (the formatters are unit-covered by
/// StatsFormat tests; this is the missing e2e wiring).
@MainActor
final class CardRichnessUITests: PiDashboardUITestCase {

    /// Narrow the list to Cartographer so the asserted rich elements belong to a card
    /// known to carry that data (search matches his name + force-expands tiers).
    private func showCartographer() {
        launch()
        connectAndEnterList()
        let field = waitFor("list-search")
        field.tap()
        field.typeText("cart")
        _ = waitFor("session-card-fix-cartographer", 8)
    }

    /// The context-usage bar renders with a percentage value (Cartographer is at
    /// 152k/200k → ~76%). Its accessibilityValue carries the formatted percent.
    func testContextBarRendersWithPercent() {
        showCartographer()

        let bar = waitFor("session-card-context-bar", 6)
        XCTAssertTrue(bar.exists, "the context-usage bar renders for a session with context data")
        if let v = bar.value as? String {
            XCTAssertTrue(v.contains("%"), "the context bar exposes a percentage value (got \(v))")
        }
        attach("richness-context-bar")
    }

    /// The git branch badge renders for a session with a `gitBranch` (Cartographer is on
    /// `feat/native-ios-app`).
    func testGitBranchBadgeRenders() {
        showCartographer()

        XCTAssertTrue(waitFor("card-git-branch", 6).exists,
                      "the git branch badge renders for a session with a branch")
        attach("richness-git-branch")
    }

    /// The driver-progress row (progress bar + next-engagement pill) renders for a driver
    /// session (Cartographer has `progress` + `nextEngagement`). The row has no dedicated
    /// id, but its presence is proven by the card being a rich drivers card with the
    /// context bar + branch above; this asserts the card itself renders richly (non-vacuous
    /// companion to the specific-element checks).
    func testDriverCardRendersRichly() {
        showCartographer()

        let card = waitFor("session-card-fix-cartographer", 6)
        XCTAssertTrue(card.exists, "the drivers card renders")
        XCTAssertTrue(exists("session-card-context-bar") && exists("card-git-branch"),
                      "the card carries multiple rich elements (context + branch)")
        attach("richness-driver-card")
    }

    /// Tokens/cost stats + a capped process list + a PR badge render when the session
    /// carries that data. The shipped fixture sessions carry none of `tokensIn`/`cost`/
    /// `processes`/`gitPrNumber`, so none of those cards render → SKIP pending a fixture
    /// that seeds them (e.g. give Cartographer processes + tokens/cost + a PR number).
    func testStatsProcessAndPRRenderWhenPresent() throws {
        showCartographer()
        _ = waitFor("session-card-fix-cartographer", 6)

        let richIds = ["card-tokens", "card-cost", "card-process-list", "card-git-pr"]
        let present = richIds.filter { exists($0) }
        guard !present.isEmpty else {
            throw XCTSkip("""
            No tokens/cost/process-list/PR cards to observe — the shipped fixture sessions carry \
            none of `tokensIn`/`tokensOut`/`cost`/`processes`/`gitPrNumber`. PENDING fixture: seed \
            one session (e.g. Cartographer) with token counts + a cost + ≥4 processes (to also \
            exercise the ≤3 "+N more" cap) + a `gitPrNumber`, so `card-tokens`/`card-cost`/ \
            `card-process-list`/`card-git-pr` render. Formatters are unit-covered (StatsFormat); \
            this is the e2e wiring. Reported to cc-ios-build. Spec authored + ready.
            """)
        }
        attach("richness-stats-present")
    }
}
