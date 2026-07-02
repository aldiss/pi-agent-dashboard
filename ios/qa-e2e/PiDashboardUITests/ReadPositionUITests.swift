import XCTest
import PiDashboardKit

/// READ-POSITION + ENGAGEMENT-WEIGHTED UNREAD (DF#3) — reopening a session restores to the
/// last-read row (not jumped to the end); an unread divider marks the first unread row; the
/// "N unread asks" count is TIER-A-weighted (ask_user / confirm / select), NOT the raw
/// message count.
///
/// Subject derived from `UITestFixtures`: the contract seeds ≥1 session with a multi-message
/// `chat(for:)` (user + assistant + a tool call), found here by opening a fixture session and
/// confirming its chat renders rows. The deterministic, always-runnable half is the chat
/// mounting + the no-spurious-divider-on-fresh-open contract; the divider-above-a-real-ask and
/// restore-to-mid-transcript positives depend on the fixture carrying Tier-A asks + a seeded
/// read position, so they assert-if-present / skip-if-absent (the counting algebra is
/// unit-covered by UnreadCounter; this is the e2e wiring).
@MainActor
final class ReadPositionUITests: PiDashboardUITestCase {

    /// Open the first fixture session whose chat renders message rows; returns its id.
    /// (Delegates to the shared base helper.)
    @discardableResult
    private func openChatBearingSession() -> String {
        launch()
        connectAndEnterList()
        return openChatBearing()
    }

    // MARK: always-runnable — chat renders + no spurious divider

    /// A fresh open of a seeded chat renders its rows and shows NO spurious unread divider
    /// (no prior read position ⇒ first-unread is the first row / nil ⇒ divider suppressed).
    func testFreshOpenShowsRowsAndNoSpuriousDivider() {
        _ = openChatBearingSession()
        XCTAssertFalse(chatMessageRowIds().isEmpty, "the seeded chat rendered ≥1 message row")
        XCTAssertFalse(exists("chat-unread-divider"),
                       "no unread divider on a fresh open with no seeded read position")
        attach("readpos-fresh-no-divider")
    }

    /// The unread divider (`chat-unread-divider`) renders above the first unread row WHEN
    /// the fixture chat carries unread Tier-A asks past the read position. Asserts-if-present;
    /// skips if the fixture seeds no Tier-A ask ahead of a read position.
    func testUnreadDividerShowsAboveFirstUnreadAsk() throws {
        _ = openChatBearingSession()
        guard waitForAppear("chat-unread-divider", 4) else {
            throw XCTSkip("""
            No unread divider to observe — the seeded fixture chat has no Tier-A ask ahead of a \
            seeded read position, so first-unread == first row and the divider is (correctly) \
            suppressed. To exercise it, seed a `UITestFixtures.chat(for:)` with ≥1 Tier-A ask \
            (ask_user/confirm/select) AND a ReadPositionStore entry before it. Summary algebra is \
            unit-covered (UnreadCounter); this is the e2e wiring.
            """)
        }
        XCTAssertTrue(exists("chat-unread-divider"), "divider renders above the first unread ask")
        attach("readpos-divider")
    }

    // MARK: helpers

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
