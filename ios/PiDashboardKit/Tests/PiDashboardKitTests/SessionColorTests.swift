import XCTest
@testable import PiDashboardKit

/// Session-list color language (color batch 1): the pure status→accent + pulse-kind
/// selection lifted from the PWA (`SessionCard.tsx` `getCardPulseClass` +
/// `session-status-visuals.ts` `deriveRailBgColor`). These are the core, UI-free
/// helpers the native card renders off — verified here via `swift test`, no
/// simulator. `sessionAccent` is the ONE semantic hue (rail+dot+word); the enforced
/// blue=interaction-only invariant lives at the bottom of this file.
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

    // MARK: ENFORCED invariant — blue = interaction-only (BUILD-3)

    /// The regression lock: NO semantic status hue may equal the interactive accent
    /// (`accentPrimary` == `accentBlue`) — checked across BOTH palettes, since the
    /// invariant must hold under the default editorial skin (interactive = terracotta
    /// `#cf6238`) AND legacy (interactive = blue `#3b82f6`). Status is carried by its
    /// OWN hue — streaming→amber, ask_user→purple, unread→cyan, live→green, error→red —
    /// and the interaction accent is reserved for affordances (links, nav, controls).
    /// Guards against re-introducing the old backwards `statusColor` (streaming→blue).
    func testStatusHuesNeverEqualInteractiveAccent() {
        for palette in [DashboardTheme.editorialDark, DashboardTheme.dark] {
            XCTAssertEqual(palette.accentPrimary, palette.accentBlue,
                           "interactive accent is the aliased accentBlue")
            let interactive = palette.accentBlue // editorial terracotta / legacy blue
            let semanticStatusHues = [
                palette.statusActive, palette.statusWorking, palette.statusNeedsInput,
                palette.statusUnread, palette.statusError, palette.statusEnded,
            ]
            for hue in semanticStatusHues {
                XCTAssertNotEqual(hue, interactive,
                                  "a semantic status hue must never be the interactive accent (\(interactive))")
            }
        }
    }

    /// Every session status resolves through `sessionAccent` to its semantic hue and
    /// NEVER to the interactive accent — the mapping-level half of the invariant.
    func testSessionAccentNeverInteractiveAccent() {
        let interactive = p.accentBlue
        // streaming is the historical offender (old statusColor sent it to blue).
        XCTAssertEqual(DashboardTheme.sessionAccent(session(status: "streaming"), p), p.statusWorking)
        XCTAssertNotEqual(DashboardTheme.sessionAccent(session(status: "streaming"), p), interactive,
                          "streaming is AMBER, not the interactive blue (the regression this locks out)")
        for status in ["active", "idle", "streaming", "ended", "weird"] {
            XCTAssertNotEqual(DashboardTheme.sessionAccent(session(status: status), p), interactive)
            XCTAssertNotEqual(DashboardTheme.sessionAccent(session(status: status), hasError: true, p),
                              interactive, "error path is RED, never interactive blue")
        }
        // Pulse overlays (working/needsInput/unread) are likewise semantic, never blue.
        for kind in [CardPulseKind.working, .needsInput, .unread] {
            XCTAssertNotEqual(DashboardTheme.pulseAccent(kind, p), interactive)
        }
    }

    /// The one-hue contract at the source: rail + dot + spoken word all derive from the
    /// SAME `sessionAccent` value (the card can't paint the rail one hue and the dot
    /// another). Asserted on the pure helper the three call sites share.
    func testCardOneHueSingleSource() {
        for status in ["active", "streaming", "ended"] {
            let s = session(status: status)
            let hue = DashboardTheme.sessionAccent(s, p)
            // Idempotent + deterministic: every read of the shared helper is the one hue.
            XCTAssertEqual(DashboardTheme.sessionAccent(s, p), hue)
        }
        XCTAssertEqual(DashboardTheme.sessionAccent(session(status: "streaming"), p), p.statusWorking)
    }
}
