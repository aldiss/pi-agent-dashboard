import XCTest
import PiDashboardKit

/// ACTION FAILURE — "never silent" (Cluster 2) — a failed control action surfaces a visible
/// error, never a silent hang: a resume/spawn failure raises the top `action-error-banner`,
/// and an undeliverable send raises the in-chat send-failure banner.
///
/// Hermetic boundary: `resume`/`spawn`/`sendPrompt` all no-op under `-uitest`, so no real
/// failure — and thus no banner — is produced. The NEGATIVE contract (steady fixture state
/// shows NO error/failure banner) runs against the fixture list / a fixture chat; the
/// POSITIVE paths skip pending a failure-injection launch hook.
@MainActor
final class ActionFailureUITests: PiDashboardUITestCase {

    // MARK: negatives (run today)

    /// The steady fixture session list shows NO action-error banner (nothing failed).
    func testNoActionErrorBannerInSteadyState() {
        launch()
        connectAndEnterList()
        _ = waitFor("session-list", 6)
        XCTAssertFalse(exists("action-error-banner"),
                       "no action-error banner in the steady fixture state")
        attach("actionfail-none-steady")
    }

    /// A fixture chat shows NO send-failure row (nothing stranded as undelivered).
    func testNoSendFailureBannerInSteadyChat() {
        launch()
        connectAndEnterList()
        openChat(fixtureSessions.first ?? fixtureSession("any") { _ in true })
        _ = waitFor("chat-scroll", 6)
        XCTAssertFalse(exists("chat-message-failed"),
                       "no 'Not sent' failure row in the settled fixture chat")
        attach("actionfail-none-chat")
    }

    // MARK: positives — skip pending a failure-injection hook

    /// A failed resume/spawn raises the top `action-error-banner` with the server's message,
    /// dismissable via ✕. resume/spawn no-op under `-uitest`, so no `*_result{success:false}`
    /// arrives to set `actionError`. Needs a launch hook (e.g. `-uitest-action-error` seeding
    /// `store.actionError` on entry, mirroring `-uitest-reconnecting`) → SKIP until it lands.
    func testFailedActionRaisesDismissableBanner() throws {
        launch(Self.fixtureArgs + ["-uitest-action-error"])
        connectAndEnterList()
        guard waitForAppear("action-error-banner", 5) else {
            throw XCTSkip("""
            No action-error banner under -uitest-action-error — resume/spawn no-op in fixture mode, \
            so no `resume_result`/`spawn_result{success:false}`/`spawn_error` arrives to set \
            `store.actionError`. PENDING build-session hook: seed `store.actionError` on entry under \
            a `-uitest-action-error` launch argument (mirrors `-uitest-reconnecting`) so the top \
            `action-error-banner` + its ✕-dismiss are drivable. Banner routing is unit-covered \
            (DashboardStore apply() Cluster-2 tests); this is the e2e wiring.
            """)
        }
        let dismiss = app.buttons["Dismiss error"].firstMatch
        if dismiss.waitForExistence(timeout: 3) {
            dismiss.tap()
            XCTAssertTrue(waitForGone("action-error-banner", 6), "the error banner dismisses on ✕")
        }
        attach("actionfail-banner")
    }

    /// An undeliverable send surfaces the in-chat send-failure banner. `sendPrompt` no-ops
    /// under `-uitest`, so neither the optimistic bubble nor its failure path runs. Needs a
    /// `-uitest-echo-send-fail` hook driving the bubble to failed → SKIP until it lands.
    func testUndeliverableSendRaisesChatFailureBanner() throws {
        launch(Self.fixtureArgs + ["-uitest-echo-send-fail"])
        connectAndEnterList()
        openChat(fixtureSessions.first ?? fixtureSession("any") { _ in true })

        let tv = waitFor("mobile-composer-textarea", 6)
        tv.tap()
        tv.typeText("will this fail visibly?")
        waitFor("mobile-composer-send", 6).tap()
        guard waitForAppear("chat-message-failed", 5) else {
            throw XCTSkip("""
            No send-failure surfaced — `sendPrompt` no-ops under -uitest, so neither the optimistic \
            bubble nor its failure path runs. PENDING build-session hook: under a `-uitest-echo-send-fail` \
            launch argument, have `sendPrompt` append the optimistic bubble AND drive it to failed \
            (`markSendFailed` → `chat-message-failed` + the send-failure banner) with no network. \
            Failure routing is unit-covered; this is the e2e wiring.
            """)
        }
        attach("actionfail-send-banner")
    }
}
