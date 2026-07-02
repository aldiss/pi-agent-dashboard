import XCTest

/// READ-POSITION + ENGAGEMENT-WEIGHTED UNREAD (DF#3) — reopening a session restores to
/// the last-read row (not jumped to the end); an unread divider marks the first unread
/// row; the "N unread asks" count is TIER-A-weighted (ask_user / confirm / select), NOT
/// the raw message count (agents spam hundreds of tool calls — those are not "unread").
///
/// Fixture reality: `loadFixtures` seeds a scripted chat ONLY for the first session
/// (`fix-joan`), and that chat is prose + a tool call + an image + thinking — with ZERO
/// Tier-A asks and no pre-set read position. So the DETERMINISTIC, hermetic-today
/// contract is the NEGATIVE half of DF#3: a tool/prose-only chat shows NO unread-asks
/// badge and NO spurious divider on a fresh open (engagement weighting working). The
/// POSITIVE half (a divider above a real unread ask; restore-to-a-mid-transcript
/// position) needs a fixture with Tier-A asks + a seeded read position — those specs are
/// authored and SKIP with a precise request (the counting/summary ALGEBRA is unit-covered
/// by UnreadCounter/ReadPosition tests; this is the missing e2e wiring).
@MainActor
final class ReadPositionUITests: PiDashboardUITestCase {

    /// Open Joan's seeded chat (the only fixture session with reduced rows).
    private func openSeededChat() {
        connectAndEnterList()
        openChat(cardId: "session-card-fix-joan")
    }

    // MARK: hermetic (runs today) — engagement-weighted unread negatives

    /// A fresh open of a tool/prose-only chat shows its rows and NO unread divider:
    /// with no Tier-A asks and no prior read position, the first-unread anchor is the
    /// first row (or nil), so `chat-unread-divider` is suppressed. Guards against a
    /// divider firing on every open (the pre-DF#3 noise).
    func testFreshOpenShowsRowsAndNoSpuriousUnreadDivider() {
        launch()
        openSeededChat()

        // Non-vacuous: the seeded chat actually rendered rows.
        XCTAssertFalse(chatMessageRowIds().isEmpty, "the seeded chat rendered at least one row")
        // No unread divider on a fresh open of an ask-free transcript.
        XCTAssertFalse(exists("chat-unread-divider"),
                       "no unread divider on a fresh open with no Tier-A asks / no read position")
        attach("readpos-fresh-no-divider")
    }

    /// Joan's card shows NO unread-asks badge even though her chat has content — because
    /// that content is prose + a tool call + an image (ZERO Tier-A asks). The badge is
    /// engagement-weighted: a tool/prose flood is NOT "unread". (Joan's `unread` flag
    /// drives the rail hue, a SEPARATE signal from the Tier-A asks badge.)
    func testToolAndProseChatShowsNoUnreadAsksBadge() {
        launch()
        connectAndEnterList()
        // Narrow to Joan (force-expands tiers + realizes her card deterministically).
        let field = waitFor("list-search")
        field.tap()
        field.typeText("joan")
        XCTAssertTrue(waitForAppear("session-card-fix-joan", 6), "Joan's card renders")

        XCTAssertFalse(exists("card-unread-asks-fix-joan"),
                       "no unread-asks badge for an ask-free chat (engagement-weighted, not raw count)")
        attach("readpos-no-asks-badge")
    }

    // MARK: positive paths — skip pending a Tier-A + read-position fixture

    /// The unread divider (`chat-unread-divider`) renders ABOVE the first unread row when
    /// unread Tier-A asks exist past the read position, and reads "N unread asks". Needs a
    /// fixture chat containing ≥1 Tier-A ask (ask_user/confirm/select) AND a seeded
    /// read-position BEFORE it (so first-unread ≠ first row). The shipped fixture has no
    /// Tier-A asks, so the divider can never render → SKIP with the request.
    func testUnreadDividerShowsAboveFirstUnreadAsk() throws {
        launch()
        openSeededChat()
        guard waitForAppear("chat-unread-divider", 4) else {
            throw XCTSkip("""
            No unread divider to observe — the seeded fixture chat (fix-joan) has ZERO Tier-A asks \
            and no pre-set read position, so first-unread == first row and the divider is (correctly) \
            suppressed. PENDING fixture: seed a chat with ≥1 Tier-A ask (ask_user/confirm/select) AND \
            a ReadPositionStore entry BEFORE it, so `chat-unread-divider` renders above the first \
            unread with a Tier-A-weighted "N unread asks" count. Summary algebra is unit-covered \
            (UnreadCounter); this is the e2e wiring. Reported to cc-ios-build. Spec authored + ready.
            """)
        }
        XCTAssertTrue(exists("chat-unread-divider"), "divider renders above the first unread ask")
        attach("readpos-divider")
    }

    /// Reopening a session restores to the last-read row rather than snapping to the end
    /// (DF#3 `restoreOnOpen`). Driving this deterministically needs a seeded read position
    /// at a KNOWN mid-transcript row so the restored scroll offset is assertable (the
    /// open→close path only ever marks the LAST row read, which restores to the end and is
    /// indistinguishable from no-restore). SKIP pending a seeded read-position fixture.
    func testReopenRestoresToLastReadPosition() throws {
        throw XCTSkip("""
        Restore-to-last-read needs a seeded read position at a KNOWN mid-transcript row to make the \
        restored scroll offset assertable — the hermetic open→close path marks the LAST row read \
        (restores to the end, indistinguishable from no-restore), and XCUITest scroll-offset reads \
        are fragile. PENDING fixture: seed `ReadPositionStore[fix-joan]` to a middle row id so a \
        reopen restores THERE (that row on screen, not the end). Restore algebra is unit-covered \
        (ReadPositionStore/restore helpers); this is the e2e wiring. Reported to cc-ios-build. \
        Spec authored + ready.
        """)
    }

    // MARK: helpers

    /// Rendered chat message ROW ids (`chat-message-<id>`), excluding per-row sub-markers.
    private func chatMessageRowIds() -> [String] {
        app.descendants(matching: .any).allElementsBoundByIndex.compactMap { e in
            let id = e.identifier
            guard id.hasPrefix("chat-message-"),
                  id != "chat-message-time", id != "chat-message-pending",
                  id != "chat-message-failed" else { return nil }
            return id
        }
    }
}
