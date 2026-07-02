import XCTest
import PiDashboardKit

/// F1–F3: Connect → Session list parity → Open session.
///
/// F1 deliberately exercises the CONNECT SCREEN, so it launches WITHOUT `-uitest-fixtures`
/// (the app then shows the connect form: `["-uitest"]` for the hermetic prefill+submit
/// path, `[]` for the live connection-refused error path). F2/F3 run in the default
/// fixture-boot mode (populated list instantly) and derive their subject from
/// `UITestFixtures` rather than a hardcoded id.
@MainActor
final class ConnectAndListUITests: PiDashboardUITestCase {

    // MARK: F1 — Connect (connect-screen path, NON-fixtures launch)

    /// F1 happy path: launch the connect screen (non-fixtures `-uitest`) → `connect-server-url`
    /// prefilled with the localhost default → tap `connect-submit` → `session-list` appears.
    func testF1_ConnectEntersSessionList() {
        launch(["-uitest"]) // connect-screen path: -uitest loads fixtures on submit, no auto-boot
        let url = waitFor("connect-server-url")
        XCTAssertEqual(url.value as? String, "http://localhost:8000",
                       "URL field prefilled with the localhost default")
        attach("F1-connect")

        waitFor("connect-submit").tap()
        XCTAssertTrue(waitFor("session-list").exists, "session list renders after connect")
    }

    /// F1 error path: a BAD url (closed local port) surfaces `connect-error`, without
    /// `session-list`. Runs WITHOUT any `-uitest*` so the real RestClient health probe runs
    /// — but points at `127.0.0.1:1` (connection-refused, instant), still hermetic.
    func testF1_UnreachableServerShowsError() {
        launch([])  // live connect path (no fixtures)
        let url = waitFor("connect-server-url")
        replaceText(url, with: "http://127.0.0.1:1")
        waitFor("connect-submit").tap()

        XCTAssertTrue(waitFor("connect-error", 15).exists, "unreachable server surfaces the error banner")
        XCTAssertFalse(exists("session-list"), "no session list on a failed connect")
        attach("F1-connect-error")
    }

    // MARK: F2 — List parity (fixture boot)

    /// F2: the fixture set boots a populated list — the tier a fixture session lands in
    /// renders, and its card shows a name + status chip.
    func testF2_ListShowsTiersAndCardFields() {
        launch()
        connectAndEnterList()

        let subject = fixtureSessions.first ?? fixtureSession("any") { _ in true }
        let tier = SessionGrouping.groupByTier(fixtureSessions)
            .first { $0.sessions.contains(where: { $0.id == subject.id }) }?.tier
        if let tier {
            XCTAssertTrue(waitFor("tier-section-\(tier.rawValue)", 8).exists, "a tier section renders")
        }

        let card = waitFor(cardId(subject), 8)
        XCTAssertTrue(card.exists, "a fixture card renders")
        XCTAssertTrue(exists("session-card-name"), "a card display-name label is present")
        let status = el("session-card-status")
        XCTAssertTrue(status.exists, "a status chip is present")
        if let v = status.value as? String {
            XCTAssertFalse(v.isEmpty, "status chip carries a value")
        }
        attach("F2-list")
    }

    // MARK: F3 — Open session (fixture boot)

    /// F3: tap a fixture `session-card-<id>` → `chat-scroll` + `mobile-composer` appear.
    /// (On appear the app sends `session_view`; in fixture mode that send is a no-op
    /// safeguard — the OBSERVABLE e2e effect is the chat surface mounting.) Also verifies
    /// the nav round-trips back to the list.
    func testF3_OpenSessionShowsChatAndComposer() {
        launch()
        connectAndEnterList()

        let subject = fixtureSessions.first ?? fixtureSession("any") { _ in true }
        waitFor(cardId(subject), 8).tap()

        XCTAssertTrue(waitFor("chat-scroll", 10).exists, "chat scroll mounts on open")
        XCTAssertTrue(waitFor("mobile-composer", 10).exists, "composer mounts on open")
        XCTAssertNotNil(composerLayoutValue(), "composer exposes its layout value")
        attach("F3-chat-open")

        let backButton = app.navigationBars.buttons.firstMatch
        if backButton.exists { backButton.tap() }
        XCTAssertTrue(waitFor("session-list", 8).exists, "navigates back to the list")
    }
}
