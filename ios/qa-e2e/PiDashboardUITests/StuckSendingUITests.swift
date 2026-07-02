import XCTest

/// BACKFILL #2 — a sent message must NOT get stuck showing "Sending…": the optimistic
/// user bubble reconciles to confirmed. Regression guard for the operator's daily bug
/// (`fix(ios): stuck "Sending…"`, 9640dbb): the optimistic bubble was confirmed only
/// by a fragile trimmed-text match against the server echo; when that didn't land
/// (bridge committed straight to work, whitespace/skill-envelope drift) the bubble
/// rotted at `.pending` forever, and `sendPrompt` was fire-and-forget (no ack, no
/// timeout). The fix confirms by `queueNonce` first + adds a ~10s ack safety-net that
/// reconciles a still-pending bubble to `.confirmed`.
///
/// Observable contract (ChatMessageRow):
///   • `.pending`   → the "Sending…" footer, id `chat-message-pending`
///   • `.confirmed` → NO footer
///   • `.failed`    → the "Not sent" footer, id `chat-message-failed`
/// So "stuck Sending" is exactly: `chat-message-pending` present and never clearing.
///
/// This file lands the hermetic guard that runs today (`testFixtureChatHasNothing…`)
/// and authors the full send→reconcile positive path. That positive path needs a
/// build-session hook (`sendPrompt` deliberately no-ops under `-uitest` — DashboardStore
/// §Compose — so the optimistic bubble can't be produced hermetically); until it lands
/// the positive test SKIPS with a precise request rather than failing (the same
/// pattern the F6-positive banner test uses). Reported to cc-ios-build.
@MainActor
final class StuckSendingUITests: PiDashboardUITestCase {

    /// Open a fixture chat that renders rows. `UITestFixtures` seeds ≥1 session with a
    /// multi-message `chat(for:)` (a user prompt, assistant markdown, a tool call), found
    /// via the shared `openChatBearing` helper — so the chat has real reduced rows.
    private func openSeededChat() {
        connectAndEnterList()
        openChatBearing()
    }

    // MARK: hermetic guard (runs today) — nothing is stranded at "Sending…"

    /// The reduced fixture chat renders SETTLED: rows are present, and NONE carries the
    /// pending "Sending…" (or "Not sent") footer. This guards the observable symptom —
    /// a user row stuck mid-send. It would catch a reducer regression that left a
    /// dashboard-echoed user row at `.pending`, or a future fixture that seeded an
    /// optimistic bubble the reconcile path never cleared.
    func testFixtureChatHasNothingStuckSending() {
        launch()
        openSeededChat()

        // Non-vacuous: at least one chat row actually rendered (the fixture's rich
        // reduced content), so "no pending footer" is a real observation, not an
        // empty screen.
        XCTAssertFalse(chatMessageRowIdentifiers().isEmpty,
                       "the seeded fixture chat rendered at least one message row")

        // The core assertion: nothing is stuck at "Sending…" and nothing is "Not sent".
        XCTAssertFalse(exists("chat-message-pending"),
                       "no message is stuck showing 'Sending…' in the settled fixture chat")
        XCTAssertFalse(exists("chat-message-failed"),
                       "no message is showing 'Not sent' in the settled fixture chat")
        attach("stuck-sending-guard-settled")
    }

    // MARK: positive path (send → reconcile) — skips pending the build hook

    /// The full regression: SEND a message → an optimistic "Sending…" bubble appears →
    /// it reconciles to confirmed (the "Sending…" footer clears) within the ack window,
    /// and it does NOT flip to "Not sent". Drives the exact fix (nonce-confirm +
    /// ~10s ack safety-net).
    ///
    /// PENDING build-session hook: `DashboardStore.sendPrompt` returns early under
    /// `-uitest` (a hard safety so the suite can never mutate a live operator session),
    /// and the ack-net reconcile lives INSIDE `sendPrompt` — so no optimistic bubble is
    /// produced in fixture mode and this path can't run hermetically today. It needs a
    /// small app affordance: under a `-uitest-echo-send` launch argument (fixture mode),
    /// have `sendPrompt` append the optimistic `optim-<nonce>` bubble AND schedule the
    /// same reconcile-to-confirmed safety-net (no network), so a fixture send exercises
    /// the pending→confirmed transition end-to-end. Until that lands the test SKIPS with
    /// this note (it does not fail) — the spec is authored + ready. App-target change =
    /// cc-ios-build owned (reported to SwiftPilot).
    func testSendReconcilesOptimisticBubbleToConfirmed() throws {
        launch(Self.fixtureArgs + ["-uitest-echo-send"])
        openSeededChat()

        let textView = waitFor("mobile-composer-textarea", 8)
        textView.tap()
        textView.typeText("does this reconcile?")
        let send = waitFor("mobile-composer-send", 6)
        XCTAssertTrue(send.isEnabled, "send enabled with text")
        send.tap()

        // The optimistic "Sending…" bubble should appear on tap. If it does not, the
        // echo-send hook isn't wired (sendPrompt no-ops under plain -uitest) → SKIP.
        guard waitForAppear("chat-message-pending", 5) else {
            throw XCTSkip("""
            No optimistic 'Sending…' bubble under -uitest (sendPrompt no-ops in fixture \
            mode, and the ack-net reconcile lives inside it). PENDING build-session hook: \
            under a `-uitest-echo-send` argument, sendPrompt should append the \
            optim-<nonce> bubble AND schedule the reconcile-to-confirmed safety-net (no \
            network) so a fixture send drives the pending→confirmed transition. Reported \
            to cc-ios-build (guards fix 9640dbb). Spec authored + ready.
            """)
        }
        attach("stuck-sending-optimistic-pending")

        // The fix's ack safety-net reconciles a still-pending bubble to confirmed —
        // the "Sending…" footer must CLEAR (confirmed renders no footer) within the
        // ack window (~10s + slack), and must NOT flip to "Not sent".
        XCTAssertTrue(waitForGone("chat-message-pending", 20),
                      "the optimistic bubble reconciles to confirmed — 'Sending…' clears")
        XCTAssertFalse(exists("chat-message-failed"),
                       "a successfully-sent message is never marked 'Not sent'")
        attach("stuck-sending-reconciled-confirmed")
    }

    // MARK: helpers

    /// Ids of the rendered chat message ROWS (`chat-message-<id>`), excluding the
    /// per-row sub-markers (`-time`, `-pending`, `-failed`) so the count reflects
    /// actual message rows.
    private func chatMessageRowIdentifiers() -> [String] {
        app.descendants(matching: .any).allElementsBoundByIndex.compactMap { e in
            let id = e.identifier
            guard id.hasPrefix("chat-message-"),
                  id != "chat-message-time",
                  id != "chat-message-pending",
                  id != "chat-message-failed" else { return nil }
            return id
        }
    }
}
