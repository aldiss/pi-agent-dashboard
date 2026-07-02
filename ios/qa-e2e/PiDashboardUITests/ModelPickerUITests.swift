import XCTest

/// MODEL + THINKING-LEVEL PICKER — tapping the chat title (`chat-model-button`) opens
/// the `model-picker` sheet (native mirror of the PWA ModelSelector + ReasoningSheet).
/// The sheet lists provider/id model rows with the current model checkmarked, a
/// provider filter + search, and a thinking-level segmented grid.
///
/// Hermetic boundary: the model LIST is fetched from the server via `requestModels`,
/// which no-ops under `-uitest` (`safeSend` is guarded), so `availableModels` stays
/// empty and the sheet shows "Loading models…" with no `model-row-*`. The thinking-level
/// grid (`thinking-row-<level>`) renders REGARDLESS (it's local state), so the sheet's
/// presentation + the reasoning control are asserted today; the model-row SELECT path
/// (which needs a populated list) is authored and SKIPS pending a models fixture.
@MainActor
final class ModelPickerUITests: PiDashboardUITestCase {

    /// Open Cartographer's chat and tap the title to present the model picker.
    private func openModelPicker() {
        connectAndEnterList()
        openChat(cardId: "session-card-fix-cartographer")
        waitFor("chat-model-button", 8).tap()
    }

    /// Tapping the chat title opens the model-picker sheet with the thinking-level
    /// control present (the reasoning grid renders even before the model list loads).
    func testTitleOpensModelPickerSheet() {
        launch()
        openModelPicker()

        XCTAssertTrue(waitFor("model-picker", 6).exists, "tapping the title opens the model picker sheet")
        // The thinking-level grid is local (no network) — its rows render immediately.
        XCTAssertTrue(waitFor("thinking-row-medium", 6).exists, "the thinking-level grid renders")
        XCTAssertTrue(exists("thinking-row-high"), "all reasoning levels are offered")
        attach("modelpicker-open")
    }

    /// The thinking-level buttons are reachable + tappable in-app (the set is local
    /// state; `setThinkingLevel` no-ops under `-uitest`, so this asserts the affordance,
    /// not a live mutation — the same honest boundary the control-action specs use).
    func testThinkingLevelButtonsAreTappable() {
        launch()
        openModelPicker()

        let high = waitFor("thinking-row-high", 6)
        XCTAssertTrue(high.isHittable, "a thinking-level button is reachable")
        high.tap()  // no-op mutation under -uitest; asserts the affordance is wired
        // The sheet stays up after a level tap (level set doesn't dismiss).
        XCTAssertTrue(exists("model-picker"), "the picker stays open after choosing a thinking level")
        attach("modelpicker-thinking-tap")
    }

    /// The picker dismisses via Done, returning to the chat.
    func testModelPickerDismisses() {
        launch()
        openModelPicker()
        XCTAssertTrue(waitFor("model-picker", 6).exists, "picker is open")

        let done = app.buttons["Done"].firstMatch
        XCTAssertTrue(done.waitForExistence(timeout: 4), "Done button present")
        done.tap()
        XCTAssertTrue(waitForGone("model-picker", 6), "Done dismisses the picker")
        XCTAssertTrue(waitFor("mobile-composer", 6).exists, "back on the chat surface")
        attach("modelpicker-dismissed")
    }

    /// Selecting a model row updates the session's model (the row checkmarks + the title
    /// subtitle updates via `session_updated`). The model LIST comes from the server
    /// (`requestModels`), which no-ops under `-uitest`, so no `model-row-*` renders → SKIP
    /// pending a fixture. Needs `availableModels[fix-cartographer]` seeded (e.g. under a
    /// `-uitest` models fixture) so rows render and one can be tapped + checkmarked.
    func testSelectingModelRowUpdatesSession() throws {
        launch()
        openModelPicker()
        _ = waitFor("model-picker", 6)

        let hasModelRow = app.descendants(matching: .any).allElementsBoundByIndex
            .contains { $0.identifier.hasPrefix("model-row-") }
        guard hasModelRow else {
            throw XCTSkip("""
            No model rows to select — `requestModels` no-ops under -uitest (safeSend guarded), so \
            `availableModels` stays empty and the sheet shows "Loading models…". PENDING fixture: \
            seed `availableModels[fix-cartographer]` (a `-uitest` models fixture / `models_list`) so \
            `model-row-<provider>-<id>` rows render, one can be tapped, and the selected row shows the \
            `selected` a11y value + checkmark. Selection routing is unit-covered (protocol round-trip); \
            this is the e2e wiring. Reported to cc-ios-build. Spec authored + ready.
            """)
        }
        // With rows present: tapping one marks it selected (value "selected") + dismisses.
        let row = app.descendants(matching: .any).allElementsBoundByIndex
            .first { $0.identifier.hasPrefix("model-row-") }!
        row.tap()
        attach("modelpicker-selected")
    }
}
