import XCTest

/// F1–F3: Connect → Session list parity → Open session.
/// Driven entirely through the TEST-CONTRACT §A accessibility identifiers against
/// the hermetic `-uitest` fixture snapshot (no live operator session touched).
@MainActor
final class ConnectAndListUITests: PiDashboardUITestCase {

    // MARK: F1 — Connect

    /// F1 happy path: launch → `connect-server-url` prefilled with the localhost
    /// default → tap `connect-submit` → `session-list` appears.
    func testF1_ConnectEntersSessionList() {
        launch()
        let url = waitFor("connect-server-url")
        XCTAssertEqual(url.value as? String, "http://localhost:8000",
                       "URL field prefilled with the localhost default")
        attach("F1-connect")

        waitFor("connect-submit").tap()
        XCTAssertTrue(waitFor("session-list").exists, "session list renders after connect")
    }

    /// F1 error path: a BAD url (closed local port) surfaces `connect-error`,
    /// without `session-list`. Runs WITHOUT `-uitest` so the real RestClient health
    /// probe runs — but points at `127.0.0.1:1` (connection-refused, instant), so it
    /// is still hermetic: no live dashboard, no operator session, no network egress.
    func testF1_UnreachableServerShowsError() {
        launch([])  // live connect path (no fixtures)
        let url = waitFor("connect-server-url")
        replaceText(url, with: "http://127.0.0.1:1")
        waitFor("connect-submit").tap()

        XCTAssertTrue(waitFor("connect-error", 15).exists, "unreachable server surfaces the error banner")
        XCTAssertFalse(exists("session-list"), "no session list on a failed connect")
        attach("F1-connect-error")
    }

    // MARK: F2 — List parity

    /// F2: at least one `tier-section-*` renders and cards show name + status.
    /// The fixture spans drivers / standing-crew / cell-executor / operator-chat /
    /// worker / other, so multiple tier sections are present.
    func testF2_ListShowsTiersAndCardFields() {
        launch()
        waitFor("connect-submit").tap()
        waitFor("session-list")

        // Drivers tier is present (Cartographer + Keystone live under nos-cells/*-driver).
        XCTAssertTrue(waitFor("tier-section-drivers", 8).exists, "a tier section renders")

        // A known card shows its name + status chip.
        let card = waitFor("session-card-fix-cartographer", 8)
        XCTAssertTrue(card.exists, "the Cartographer card renders")
        XCTAssertTrue(exists("session-card-name"), "a card display-name label is present")
        let status = el("session-card-status")
        XCTAssertTrue(status.exists, "a status chip is present")
        // status chip exposes the raw status as its accessibilityValue.
        if let v = status.value as? String {
            XCTAssertFalse(v.isEmpty, "status chip carries a value")
        }
        attach("F2-list")
    }

    // MARK: F3 — Open session

    /// F3: tap a `session-card-<id>` → `chat-scroll` + `mobile-composer` appear.
    /// (On appear the app sends `session_view`; in fixture mode that send is a
    /// no-op safeguard — the OBSERVABLE e2e effect is the chat surface mounting.
    /// The `session_view` wire message itself is asserted at the unit layer in
    /// ProtocolRoundTripTests.) Also verifies the nav round-trips back to the list.
    func testF3_OpenSessionShowsChatAndComposer() {
        launch()
        waitFor("connect-submit").tap()
        waitFor("session-list")

        waitFor("session-card-fix-cartographer", 8).tap()

        XCTAssertTrue(waitFor("chat-scroll", 10).exists, "chat scroll mounts on open")
        XCTAssertTrue(waitFor("mobile-composer", 10).exists, "composer mounts on open")
        XCTAssertNotNil(composerLayoutValue(), "composer exposes its layout value")
        attach("F3-chat-open")

        // Round-trip: navigate back → the list is shown again.
        let backButton = app.navigationBars.buttons.firstMatch
        if backButton.exists { backButton.tap() }
        XCTAssertTrue(waitFor("session-list", 8).exists, "navigates back to the list")
    }
}
