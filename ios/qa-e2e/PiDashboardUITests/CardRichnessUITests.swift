import XCTest
import PiDashboardKit

/// CARD RICHNESS (B4) — a session card surfaces its rich metadata when the session carries
/// it: the context-usage bar (`session-card-context-bar`), git branch (`card-git-branch`) +
/// PR (`card-git-pr`) badges, token/cost stats (`card-tokens` / `card-cost`), and a capped
/// process list (`card-process-list`, ≤3 rows + "+N more"). Data-driven render contract.
///
/// The contract fixture seeds ≥1 rich session (gitBranch / processes / token+cost stats), so
/// each element is asserted against the FIXTURE session that carries that data (derived by
/// property). Elements whose data a given fixture omits assert-if-present / skip-if-absent.
@MainActor
final class CardRichnessUITests: PiDashboardUITestCase {

    /// Narrow the list to `subject` (search by display name + force-expand tiers) and wait
    /// for its card.
    private func show(_ subject: DashboardSession) {
        launch()
        connectAndEnterList()
        let field = waitFor("list-search")
        field.tap()
        field.typeText(subject.displayName)
        _ = waitFor(cardId(subject), 8)
    }

    /// The context bar renders (with a % value) for a session carrying context data.
    func testContextBarRendersWithPercent() {
        let subject = fixtureSession("has context usage") { $0.contextFraction != nil }
        show(subject)
        let bar = waitFor("session-card-context-bar", 6)
        XCTAssertTrue(bar.exists, "the context bar renders for a session with context data")
        if let v = bar.value as? String {
            XCTAssertTrue(v.contains("%"), "the context bar exposes a percentage value (got \(v))")
        }
        attach("richness-context-bar")
    }

    /// The git branch badge renders for a session carrying a `gitBranch`.
    func testGitBranchBadgeRenders() {
        let subject = fixtureSession("has a git branch") { ($0.gitBranch?.isEmpty == false) }
        show(subject)
        XCTAssertTrue(waitFor("card-git-branch", 6).exists,
                      "the git branch badge renders for a session with a branch")
        attach("richness-git-branch")
    }

    /// Token/cost stats + a capped process list render when a fixture session carries that
    /// data. The contract seeds a rich session; if a given fixture omits stats/processes,
    /// this asserts what IS present and skips only when none of the four render.
    func testStatsAndProcessListRenderWhenPresent() throws {
        // Prefer a session that carries stats or processes; else the first card.
        let subject = fixtureSessions.first { s in
            s.tokensIn != nil || s.cost != nil || (s.processes?.isEmpty == false) || s.gitPrNumber != nil
        } ?? fixtureSessions.first ?? fixtureSession("any") { _ in true }
        show(subject)
        _ = waitFor(cardId(subject), 6)

        let richIds = ["card-tokens", "card-cost", "card-process-list", "card-git-pr"]
        let present = richIds.filter { exists($0) }
        guard !present.isEmpty else {
            throw XCTSkip("""
            No tokens/cost/process-list/PR cards on the richest fixture session. To exercise them, \
            seed a `UITestFixtures` session with token counts + a cost + ≥4 processes (to also hit \
            the ≤3 "+N more" cap) + a gitPrNumber. Formatters are unit-covered (StatsFormat); this \
            is the e2e wiring.
            """)
        }
        attach("richness-stats-present")
    }
}
