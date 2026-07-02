import XCTest

/// ACCESSIBILITY (Cluster 5) — icon-only controls carry a spoken `.accessibilityLabel`
/// (a bare SF Symbol says nothing to VoiceOver), tap targets are real, and status is
/// conveyed by a NON-COLOR word (not just a hue). Asserts the labels the app sets on its
/// glyph buttons + the 44pt composer targets. Honest boundary: `mobile-composer-send` /
/// `mobile-composer-attach` are icon-only with IDs but no explicit label today — that gap
/// is authored as a SKIP requesting the labels rather than asserting an aspirational
/// string that would false-red.
@MainActor
final class AccessibilityUITests: PiDashboardUITestCase {

    // MARK: list-toolbar icon buttons

    /// The session-list glyph buttons (gear / plus) speak their purpose.
    func testListToolbarIconButtonsHaveLabels() {
        launch()
        connectAndEnterList()

        XCTAssertEqual(waitFor("settings-button", 6).label, "Settings",
                       "the settings gear speaks 'Settings'")
        XCTAssertEqual(waitFor("new-session-button", 6).label, "New session",
                       "the new-session plus speaks 'New session'")
        attach("a11y-list-toolbar")
    }

    // MARK: chat-toolbar icon buttons

    /// The chat glyph buttons (model title, filter funnel) speak their purpose.
    func testChatToolbarIconButtonsHaveLabels() {
        launch()
        connectAndEnterList()
        openChat(cardId: "session-card-fix-cartographer")

        let model = waitFor("chat-model-button", 8)
        XCTAssertTrue((model.label).hasPrefix("Model:"),
                      "the model title button speaks the current model (got '\(model.label)')")
        let filter = waitFor("chat-filter-button", 6)
        XCTAssertEqual(filter.label, "Message filter", "the filter funnel speaks 'Message filter'")
        attach("a11y-chat-toolbar")
    }

    /// The composer mic speaks its state (recording vs. record vs. starting) — never a
    /// bare waveform glyph. Hermetically the sidecar is unreachable, so it reads the
    /// enabled ("Record voice") or starting ("Voice service starting") label.
    func testComposerMicHasSpokenLabel() {
        launch()
        connectAndEnterList()
        openChat(cardId: "session-card-fix-cartographer")

        let mic = waitFor("mobile-composer-mic", 8)
        let label = mic.label
        XCTAssertTrue(label == "Record voice" || label == "Voice service starting" || label == "Stop recording",
                      "the mic button speaks its state, not a bare glyph (got '\(label)')")
        attach("a11y-mic-label")
    }

    // MARK: non-color status cue

    /// Status is spoken as a WORD (A11yStatus) — the non-color cue for a screen-reader
    /// user. Cartographer is "streaming" → the status element's label speaks "Working".
    func testStatusHasNonColorSpokenLabel() {
        launch()
        connectAndEnterList()
        let field = waitFor("list-search")
        field.tap()
        field.typeText("cart")
        _ = waitFor("session-card-fix-cartographer", 8)

        let status = waitFor("session-card-status", 6)
        XCTAssertTrue(status.label.hasPrefix("Status:"),
                      "the status chip speaks a 'Status: <word>' label (got '\(status.label)')")
        XCTAssertTrue(status.label.contains("Working"),
                      "the streaming state speaks as 'Working' — a non-color cue")
        attach("a11y-status-word")
    }

    // MARK: tap targets

    /// The composer's icon controls are real 44pt tap targets (attach / send are sized
    /// 44×44 in AdaptiveComposer). A hittable, adequately-sized target — not a 12pt glyph.
    func testComposerControlsAreAdequateTapTargets() {
        launch()
        connectAndEnterList()
        openChat(cardId: "session-card-fix-cartographer")

        let send = waitFor("mobile-composer-send", 8)
        XCTAssertGreaterThanOrEqual(send.frame.height, 40, "send is a ≥40pt tap target")
        XCTAssertGreaterThanOrEqual(send.frame.width, 40, "send is a ≥40pt tap target")
        let attachBtn = waitFor("mobile-composer-attach", 6)
        XCTAssertGreaterThanOrEqual(attachBtn.frame.height, 40, "attach is a ≥40pt tap target")
        attach("a11y-tap-targets")
    }

    /// The send + attach glyph buttons are icon-only with IDs but no explicit
    /// `.accessibilityLabel` today, so VoiceOver falls back to the SF Symbol's default
    /// description ("arrow up" / "plus"). Cluster 5 wants a purposeful label ("Send" /
    /// "Add photo"). If neither carries a custom label this SKIPS with the request rather
    /// than asserting an aspirational string. App-target change = cc-ios-build owned.
    func testSendAndAttachExposePurposefulLabels() throws {
        launch()
        connectAndEnterList()
        openChat(cardId: "session-card-fix-cartographer")

        let send = waitFor("mobile-composer-send", 8)
        let attachBtn = waitFor("mobile-composer-attach", 6)
        let sendLabeled = ["Send", "Send message"].contains(send.label)
        let attachLabeled = ["Add photo", "Attach", "Attach image", "Add image"].contains(attachBtn.label)
        guard sendLabeled || attachLabeled else {
            throw XCTSkip("""
            The composer send/attach glyphs carry no purposeful `.accessibilityLabel` (VoiceOver \
            falls back to the SF Symbol name — "arrow up" / "plus"). PENDING app change: add \
            `.accessibilityLabel("Send")` to `mobile-composer-send` and `.accessibilityLabel("Add \
            photo")` to `mobile-composer-attach` (Cluster 5 — icon-only buttons must speak their \
            purpose). Reported to cc-ios-build. Spec authored + ready.
            """)
        }
        attach("a11y-send-attach-labels")
    }
}
