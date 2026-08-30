import XCTest
@testable import PiDashboardKit

/// Context-usage display must come from context fields only, never from cache
/// fields, and must never saturate to 100% for a session that is under half full.
///
/// Operator-reported: the app showed Hearth-19 at 100% context while her TUI
/// read 45.1% of 1.0M. Because the operator rotates a seat at >50%, a false
/// 100% forces a rotation that is not due, and the TUI is not visible from
/// mobile.
///
/// The numbers below are the ACTUAL live payload captured from
/// `GET /api/sessions` for the live Hearth-19 session
/// (github-copilot/claude-opus-5), not invented fixtures — so this doubles as a
/// live-shape contract. Note `cacheRead` is 22.8M against a 1.0M window: any
/// implementation that lets a cache field reach the context calculation cannot
/// produce 45% and will fail here.
final class ContextUsageDisplayTests: XCTestCase {

    /// Captured live payload — keep these values verbatim.
    private enum LiveHearth {
        static let contextTokens: Double = 450_620
        static let contextWindow: Double = 1_000_000
        static let cacheRead: Double = 22_840_180
        static let cacheWrite: Double = 6_759_645
        static let tokensIn: Double = 208
        static let tokensOut: Double = 160_681
    }

    private func liveHearthSession() -> DashboardSession {
        var s = DashboardSession(id: "hearth-19", cwd: "/w", name: "Hearth-19",
                                 source: "tmux", status: "idle")
        s.contextTokens = LiveHearth.contextTokens
        s.contextWindow = LiveHearth.contextWindow
        s.cacheRead = LiveHearth.cacheRead
        s.cacheWrite = LiveHearth.cacheWrite
        s.tokensIn = LiveHearth.tokensIn
        s.tokensOut = LiveHearth.tokensOut
        return s
    }

    /// The headline assertion: 47%, never 100%.
    func testLiveHearthPayloadReportsFortyFivePercentNotFull() {
        let frac = liveHearthSession().contextFraction
        XCTAssertNotNil(frac, "context fraction must resolve for the live payload")
        XCTAssertEqual(frac!, 0.4506, accuracy: 0.0005)
        XCTAssertEqual(Int((frac! * 100).rounded()), 45,
                       "live Hearth-19 payload must display 45%")
        XCTAssertLessThan(frac!, 0.5,
                          "must read below the operator's 50% rotation trigger")
    }

    /// A cache HIT RATIO near 100% must not influence the context reading. This is
    /// the specific wrong explanation that was proposed for the defect; pinning it
    /// means a future change that wires cache into context fails loudly.
    func testHighCacheHitRatioDoesNotInflateContextUsage() {
        var s = liveHearthSession()
        // Drive the cache ratio to ~99.8% while context stays at 46.7%.
        s.cacheRead = 99_800_000
        s.cacheWrite = 200_000
        let frac = s.contextFraction
        XCTAssertEqual(Int((frac! * 100).rounded()), 45,
                       "context must ignore cache entirely, even at a 99.8% hit ratio")
    }

    /// Control: the clamp still works, so this suite cannot be satisfied by
    /// removing the clamp. An over-full window genuinely reports 100%.
    func testGenuinelyFullContextStillReportsFull() {
        var s = liveHearthSession()
        s.contextTokens = 1_400_000
        XCTAssertEqual(Int((s.contextFraction! * 100).rounded()), 100,
                       "a genuinely over-full context still clamps to 100%")
    }

    /// Control: a stale window from a smaller model, combined with fresh tokens,
    /// is exactly the shape that saturates to a false 100%. Documents the
    /// mechanism so a fix at the merge layer has an assertion to satisfy.
    func testStaleSmallWindowWithFreshTokensSaturatesToFalseFull() {
        var s = liveHearthSession()
        s.contextWindow = 200_000          // stale window from a 200k model
        XCTAssertEqual(Int((s.contextFraction! * 100).rounded()), 100,
                       "a stale 200k window against 450k tokens saturates to 100% — " +
                       "if the app ever shows 100% for this session, the window is stale, " +
                       "not the token count")
    }
}
