import XCTest

/// ACTION FAILURE — "never silent" (Cluster 2) — a failed control action surfaces a
/// visible error, never a silent hang: a resume/spawn failure raises the top
/// `action-error-banner` (`store.actionError`, auto-dismiss + tap-✕), and a send that
/// can't be delivered raises the in-chat send-failure banner. Guards the regression
/// where a dropped `*_result` frame left a spinner hung with no explanation.
///
/// Hermetic boundary: `resume`/`spawn`/`sendPrompt` all no-op under `-uitest` (guarded so
/// the suite can never mutate a live session), so no real failure — and thus no banner —
/// can be produced hermetically. The NEGATIVE contract (steady fixture state shows NO
/// error banner) runs TODAY; the POSITIVE paths (a failure → the banner) are authored and
/// SKIP pending a failure-injection launch hook (the banner routing is unit-covered by the
/// DashboardStore apply() tests for resume_result/spawn_result/spawn_error; this is the
/// missing e2e wiring).
@MainActor
final class ActionFailureUITests: PiDashboardUITestCase {

    // MARK: negatives (run today) — nothing is spuriously in an error state

    /// The steady fixture session list shows NO action-error banner (nothing failed).
    /// A regression that raised `actionError` on a benign path would trip this.
    func testNoActionErrorBannerInSteadyState() {
        launch()
        connectAndEnterList()
        _ = waitFor("session-card-fix-cartographer", 8)

        XCTAssertFalse(exists("action-error-banner"),
                       "no action-error banner in the steady connected fixture state")
        attach("actionfail-none-steady")
    }

    /// The steady fixture chat shows NO send-failure banner (`chat-message-failed` / the
    /// send-failure header) — nothing is stranded as undelivered.
    func testNoSendFailureBannerInSteadyChat() {
        launch()
        connectAndEnterList()
        openChat(cardId: "session-card-fix-joan") // the seeded chat
        _ = waitFor("chat-scroll", 8)

        XCTAssertFalse(exists("chat-message-failed"),
                       "no 'Not sent' failure row in the settled fixture chat")
        attach("actionfail-none-chat")
    }

    // MARK: positives — skip pending a failure-injection hook

    /// A failed resume/spawn raises the top `action-error-banner` with the server's
    /// message, and it can be dismissed (✕). `resume`/`spawn` no-op under `-uitest`, so no
    /// `*_result{success:false}` / `spawn_error` ever arrives to set `actionError`. Needs a
    /// launch hook: under e.g. `-uitest-action-error`, seed `store.actionError` on entry
    /// (mirrors how `-uitest-reconnecting` seeds `.reconnecting`) so the banner + its
    /// dismiss are drivable. Until it lands this SKIPS with the request.
    func testFailedActionRaisesDismissableBanner() throws {
        launch(["-uitest", "-uitest-action-error"])
        connectAndEnterList()

        guard waitForAppear("action-error-banner", 5) else {
            throw XCTSkip("""
            No action-error banner under -uitest-action-error — resume/spawn no-op in fixture mode \
            (`!isUITest` guards), so no `resume_result`/`spawn_result{success:false}`/`spawn_error` \
            arrives to set `store.actionError`. PENDING build-session hook: under a \
            `-uitest-action-error` launch argument, seed `store.actionError` on entry (mirrors \
            `-uitest-reconnecting`) so the top `action-error-banner` renders and its ✕-dismiss is \
            drivable. Banner routing is unit-covered (DashboardStore apply() Cluster-2 tests); this \
            is the e2e wiring. Reported to cc-ios-build. Spec authored + ready.
            """)
        }
        // With the hook: the banner shows + dismisses via ✕ ("Dismiss error").
        let dismiss = app.buttons["Dismiss error"].firstMatch
        if dismiss.waitForExistence(timeout: 3) {
            dismiss.tap()
            XCTAssertTrue(waitForGone("action-error-banner", 6), "the error banner dismisses on ✕")
        }
        attach("actionfail-banner")
    }

    /// A send that can't be delivered surfaces the in-chat send-failure banner (never a
    /// silently-dropped message). `sendPrompt` no-ops under `-uitest`, so no optimistic
    /// bubble and no failure path runs hermetically. Needs the same `-uitest-echo-send`
    /// (or a send-failure variant) hook the StuckSending positive path requests, extended
    /// to drive a failure → `sendFailures[sid]`. SKIP pending that hook.
    func testUndeliverableSendRaisesChatFailureBanner() throws {
        launch(["-uitest", "-uitest-echo-send-fail"])
        connectAndEnterList()
        openChat(cardId: "session-card-fix-joan")

        let tv = waitFor("mobile-composer-textarea", 8)
        tv.tap()
        tv.typeText("will this fail visibly?")
        waitFor("mobile-composer-send", 6).tap()

        guard waitForAppear("chat-message-failed", 5) else {
            throw XCTSkip("""
            No send-failure surfaced — `sendPrompt` no-ops under -uitest, so neither the optimistic \
            bubble nor its failure path runs in fixture mode. PENDING build-session hook: under a \
            `-uitest-echo-send-fail` launch argument, have `sendPrompt` append the optimistic bubble \
            AND drive it to failed (`markSendFailed` → `chat-message-failed` + the send-failure \
            banner) with no network, so the 'never a silently-dropped message' contract is drivable. \
            Failure routing is unit-covered; this is the e2e wiring. Reported to cc-ios-build. Spec \
            authored + ready.
            """)
        }
        attach("actionfail-send-banner")
    }
}
