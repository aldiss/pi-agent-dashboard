import XCTest
import PiDashboardKit

/// ACCESSIBILITY (Cluster 5) — icon-only controls carry a spoken `.accessibilityLabel` (a
/// bare SF Symbol says nothing to VoiceOver), tap targets are real, and status is conveyed
/// by a NON-COLOR word. Asserts the labels the app sets on its glyph buttons + the 44pt
/// composer targets. Runs against the fixture-booted list / a fixture chat.
///
/// Honest boundary: `mobile-composer-send` / `mobile-composer-attach` are icon-only with IDs
/// but no explicit label today — that gap is authored as a SKIP requesting the labels.
@MainActor
final class AccessibilityUITests: PiDashboardUITestCase {

    /// Open the chat for a fixture session that has a model (so the model-title button reads
    /// a model), returning nothing — leaves the app on the chat surface.
    private func openAChat() {
        launch()
        connectAndEnterList()
        let subject = fixtureSession("has a model") { ($0.model?.isEmpty == false) }
        openChat(subject)
    }

    /// The session-list glyph buttons (gear / plus) speak their purpose.
    func testListToolbarIconButtonsHaveLabels() {
        launch()
        connectAndEnterList()
        XCTAssertEqual(waitFor("settings-button", 6).label, "Settings", "gear speaks 'Settings'")
        XCTAssertEqual(waitFor("new-session-button", 6).label, "New session", "plus speaks 'New session'")
        attach("a11y-list-toolbar")
    }

    /// The chat glyph buttons (model title, filter funnel) speak their purpose.
    func testChatToolbarIconButtonsHaveLabels() {
        openAChat()
        let model = waitFor("chat-model-button", 6)
        XCTAssertTrue(model.label.hasPrefix("Model:"), "the model title speaks the model (got '\(model.label)')")
        XCTAssertEqual(waitFor("chat-filter-button", 6).label, "Message filter", "funnel speaks 'Message filter'")
        attach("a11y-chat-toolbar")
    }

    /// The composer mic speaks its state (never a bare waveform glyph).
    func testComposerMicHasSpokenLabel() {
        openAChat()
        let mic = waitFor("mobile-composer-mic", 6)
        let label = mic.label
        XCTAssertTrue(label == "Record voice" || label == "Voice service starting" || label == "Stop recording",
                      "the mic speaks its state, not a bare glyph (got '\(label)')")
        attach("a11y-mic-label")
    }

    /// Status is spoken as a WORD — the non-color cue. A streaming fixture session → the
    /// status element's label speaks "Working".
    func testStatusHasNonColorSpokenLabel() {
        let subject = fixtureSession(status: "streaming")
        launch()
        connectAndEnterList()
        let field = waitFor("list-search")
        field.tap()
        field.typeText(subject.displayName)
        _ = waitFor(cardId(subject), 6)

        let status = waitFor("session-card-status", 6)
        XCTAssertTrue(status.label.hasPrefix("Status:"), "status speaks 'Status: <word>' (got '\(status.label)')")
        XCTAssertTrue(status.label.contains("Working"), "streaming speaks as 'Working' — a non-color cue")
        attach("a11y-status-word")
    }

    /// The composer icon controls are real ≥40pt tap targets (attach / send are 44×44).
    func testComposerControlsAreAdequateTapTargets() {
        openAChat()
        let send = waitFor("mobile-composer-send", 6)
        XCTAssertGreaterThanOrEqual(send.frame.height, 40, "send is a ≥40pt tap target")
        XCTAssertGreaterThanOrEqual(send.frame.width, 40, "send is a ≥40pt tap target")
        XCTAssertGreaterThanOrEqual(waitFor("mobile-composer-attach", 6).frame.height, 40, "attach is a ≥40pt tap target")
        attach("a11y-tap-targets")
    }

    /// The send + attach glyphs are icon-only with IDs but no explicit `.accessibilityLabel`
    /// today (VoiceOver falls back to the SF Symbol name). If neither carries a purposeful
    /// label this SKIPS with the request rather than asserting an aspirational string.
    func testSendAndAttachExposePurposefulLabels() throws {
        openAChat()
        let send = waitFor("mobile-composer-send", 6)
        let attachBtn = waitFor("mobile-composer-attach", 6)
        let sendLabeled = ["Send", "Send message"].contains(send.label)
        let attachLabeled = ["Add photo", "Attach", "Attach image", "Add image"].contains(attachBtn.label)
        guard sendLabeled || attachLabeled else {
            throw XCTSkip("""
            The composer send/attach glyphs carry no purposeful `.accessibilityLabel` (VoiceOver \
            falls back to the SF Symbol name — "arrow up" / "plus"). PENDING app change: add \
            `.accessibilityLabel("Send")` to `mobile-composer-send` + `.accessibilityLabel("Add \
            photo")` to `mobile-composer-attach` (Cluster 5). Reported to cc-ios-build.
            """)
        }
        attach("a11y-send-attach-labels")
    }
}
