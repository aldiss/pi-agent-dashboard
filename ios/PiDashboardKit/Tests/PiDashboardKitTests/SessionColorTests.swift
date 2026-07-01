import XCTest
@testable import PiDashboardKit

/// Session-list color language (color batch 1): the pure status→accent + pulse-kind
/// selection lifted from the PWA (`SessionCard.tsx` `getCardPulseClass` +
/// `session-status-visuals.ts` `deriveRailBgColor`). These are the core, UI-free
/// helpers the native card renders off — verified here via `swift test`, no
/// simulator. The legacy `statusColor` mapping is pinned separately in
/// `ComposerModelPropertyTests` and intentionally left unchanged.
final class SessionColorTests: XCTestCase {
    private let p = DashboardTheme.dark

    private func session(status: String? = nil, currentTool: String? = nil,
                         unread: Bool? = nil) -> DashboardSession {
        var s = DashboardSession(id: "s", status: status)
        s.currentTool = currentTool
        s.unread = unread
        return s
    }

    // MARK: named semantic palette

    /// The six semantic accents map to the PWA Tailwind hues (green/amber/purple/
    /// cyan/red + muted). Guards against token drift in the shared core.
    func testSemanticPaletteHues() {
        XCTAssertEqual(p.statusActive, "#22c55e")     // green-500
        XCTAssertEqual(p.statusWorking, "#eab308")    // yellow-500
        XCTAssertEqual(p.statusNeedsInput, "#a855f7") // purple-500
        XCTAssertEqual(p.statusUnread, "#06b6d4")     // cyan-500
        XCTAssertEqual(p.statusError, "#ef4444")      // red-500
        XCTAssertEqual(p.statusEnded, p.textFaint)    // muted gray
        XCTAssertEqual(p.accentCyan, "#06b6d4", "cyan token added to palette")
    }

    // MARK: sessionAccent precedence

    func testSessionAccentActiveIdleGreen() {
        XCTAssertEqual(DashboardTheme.sessionAccent(session(status: "active"), p), p.statusActive)
        XCTAssertEqual(DashboardTheme.sessionAccent(session(status: "idle"), p), p.statusActive)
    }

    func testSessionAccentStreamingAmber() {
        XCTAssertEqual(DashboardTheme.sessionAccent(session(status: "streaming"), p), p.statusWorking)
    }

    func testSessionAccentEndedFaint() {
        XCTAssertEqual(DashboardTheme.sessionAccent(session(status: "ended"), p), p.statusEnded)
    }

    /// Ended wins over error — a finished card stays muted even if it errored
    /// (mirrors `deriveRailBgColor`, where `ended` is the first branch).
    func testSessionAccentEndedBeatsError() {
        XCTAssertEqual(DashboardTheme.sessionAccent(session(status: "ended"), hasError: true, p),
                       p.statusEnded)
    }

    func testSessionAccentErrorRedWhenAlive() {
        XCTAssertEqual(DashboardTheme.sessionAccent(session(status: "active"), hasError: true, p),
                       p.statusError)
    }

    func testSessionAccentUnknownFallsBackMuted() {
        XCTAssertEqual(DashboardTheme.sessionAccent(session(status: "weird"), p), p.statusEnded)
        XCTAssertEqual(DashboardTheme.sessionAccent(session(status: nil), p), p.statusEnded)
    }

    // MARK: cardPulseKind precedence (ask_user > working > unread)

    func testPulseNeedsInputBeatsEverything() {
        // ask_user while streaming AND unread → still needsInput (needs YOU wins).
        let s = session(status: "streaming", currentTool: "ask_user", unread: true)
        XCTAssertEqual(DashboardTheme.cardPulseKind(s), .needsInput)
    }

    func testPulseWorkingBeatsUnread() {
        let s = session(status: "streaming", unread: true)
        XCTAssertEqual(DashboardTheme.cardPulseKind(s), .working)
    }

    func testPulseUnreadWhenIdleAndUnread() {
        let s = session(status: "idle", unread: true)
        XCTAssertEqual(DashboardTheme.cardPulseKind(s), .unread)
    }

    func testPulseNoneWhenCalm() {
        XCTAssertEqual(DashboardTheme.cardPulseKind(session(status: "active")), .none)
        XCTAssertEqual(DashboardTheme.cardPulseKind(session(status: "ended", unread: false)), .none)
    }

    /// An ended session with unviewed activity still gets the cyan unread pulse —
    /// the PWA shows the same "fresh activity" tint on ended cards.
    func testPulseUnreadOnEndedSession() {
        XCTAssertEqual(DashboardTheme.cardPulseKind(session(status: "ended", unread: true)), .unread)
    }

    // MARK: pulseAccent mapping

    func testPulseAccentHues() {
        XCTAssertEqual(DashboardTheme.pulseAccent(.needsInput, p), p.statusNeedsInput)
        XCTAssertEqual(DashboardTheme.pulseAccent(.working, p), p.statusWorking)
        XCTAssertEqual(DashboardTheme.pulseAccent(.unread, p), p.statusUnread)
        XCTAssertNil(DashboardTheme.pulseAccent(.none, p), "no overlay for a calm card")
    }
}
