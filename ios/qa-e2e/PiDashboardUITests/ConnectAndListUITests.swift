import XCTest
import PiDashboardKit

/// F1–F3: Connect → Session list parity → Open session — all HERMETIC under
/// `-uitest-fixtures`. The app boots STRAIGHT into the populated, "connected" list
/// (no WebSocket, no connect screen), so these assert the fixture-boot end state, NOT
/// the live connect flow. The connect-screen UI (prefill field / submit button /
/// unreachable-error banner) never renders in fixture mode — waiting on it would hang
/// the suite — and its logic is covered at the unit layer (RestClient health-probe +
/// ConnectionPreferences tests in PiDashboardKit), so the live-connect spec SKIPS here.
@MainActor
final class ConnectAndListUITests: PiDashboardUITestCase {

    // MARK: F1 — the app boots connected (fixture-boot = the hermetic "connected" state)

    /// F1 (hermetic): under `-uitest-fixtures` the app injects the fixture sessions, marks
    /// the store connected, and boots directly into the populated `session-list` — the
    /// hermetic equivalent of a successful connect. No connect screen, no `connect-submit`.
    func testF1_BootsConnectedIntoSessionList() {
        launch()
        XCTAssertTrue(waitFor("session-list", 6).exists,
                      "fixture boot lands directly on the populated session list (connected)")
        // The connect screen is bypassed — its prefill field must NOT be present.
        XCTAssertFalse(exists("connect-server-url"), "no connect screen in fixture-boot mode")
        // At least one fixture card actually rendered (non-vacuous "populated").
        XCTAssertTrue(waitForAppear(cardId(fixtureSessions.first ?? fixtureSession("any") { _ in true }), 6),
                      "a fixture card renders in the booted list")
        attach("F1-booted-connected")
    }

    /// F1 error path (live connect): a bad URL surfaces `connect-error`. This is the ONLY
    /// non-hermetic path — it needs the connect SCREEN (bypassed under `-uitest-fixtures`)
    /// and a real RestClient health probe. Skipped here to keep the suite hermetic + fast;
    /// the failure logic (probe throws → `.failed` phase → `connect-error`) is unit-covered
    /// in PiDashboardKit. Re-enable only in a dedicated non-fixtures lane.
    func testF1_UnreachableServerShowsError() throws {
        throw XCTSkip("""
        Live-connect error path skipped in the hermetic suite: it requires the connect SCREEN, which \
        `-uitest-fixtures` bypasses (the app boots straight into the populated list), plus a real \
        network probe. Waiting on `connect-submit`/`connect-error` here would hang the run. The \
        failure logic (RestClient health-probe throw → `.failed` → `connect-error`) is unit-covered \
        in PiDashboardKit; run this only in a dedicated non-fixtures connect-screen lane.
        """)
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
            XCTAssertTrue(waitFor("tier-section-\(tier.rawValue)", 6).exists, "a tier section renders")
        }

        let card = waitFor(cardId(subject), 6)
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
    /// the nav round-trips back to the list. Opens the chat-bearing fixture session so the
    /// chat renders real rows (not the empty-state loader).
    func testF3_OpenSessionShowsChatAndComposer() {
        launch()
        connectAndEnterList()

        // fix-pete is the fixture session with a scripted chat → real rows, no loader spinner.
        let subject = fixtureSessions.first { !UITestFixtures.chat(for: $0.id).messages.isEmpty }
            ?? fixtureSessions.first ?? fixtureSession("any") { _ in true }
        waitFor(cardId(subject), 6).tap()

        XCTAssertTrue(waitFor("chat-scroll", 6).exists, "chat scroll mounts on open")
        XCTAssertTrue(waitFor("mobile-composer", 6).exists, "composer mounts on open")
        XCTAssertNotNil(composerLayoutValue(), "composer exposes its layout value")
        attach("F3-chat-open")

        let backButton = app.navigationBars.buttons.firstMatch
        if backButton.exists { backButton.tap() }
        XCTAssertTrue(waitFor("session-list", 6).exists, "navigates back to the list")
    }
}
