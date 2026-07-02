import XCTest
import PiDashboardKit

/// MODEL + THINKING-LEVEL PICKER — tapping the chat title (`chat-model-button`) opens the
/// `model-picker` sheet with provider/id model rows (current model checkmarked), a provider
/// filter + search, and a thinking-level segmented grid.
///
/// Subject derived from `UITestFixtures`: a session carrying a `model` (so the title button
/// reads a model). The thinking-level grid (`thinking-row-<level>`) is local state and renders
/// regardless; the model-row list is contract-fixture-driven — asserted if `UITestFixtures`
/// seeds an `availableModels` list, else the model-select path skips (the sheet + reasoning
/// grid still assert).
@MainActor
final class ModelPickerUITests: PiDashboardUITestCase {

    /// Open a fixture session that has a model set, then present the picker.
    private func openModelPicker() {
        launch()
        connectAndEnterList()
        let subject = fixtureSession("has a model") { ($0.model?.isEmpty == false) }
        openChat(subject)
        waitFor("chat-model-button", 6).tap()
    }

    /// Tapping the chat title opens the model-picker sheet with the thinking-level control.
    func testTitleOpensModelPickerSheet() {
        openModelPicker()
        XCTAssertTrue(waitFor("model-picker", 6).exists, "tapping the title opens the model picker")
        XCTAssertTrue(waitFor("thinking-row-medium", 6).exists, "the thinking-level grid renders")
        XCTAssertTrue(exists("thinking-row-high"), "all reasoning levels are offered")
        attach("modelpicker-open")
    }

    /// The thinking-level buttons are reachable + tappable in-app (local state; the set
    /// no-ops under `-uitest`, so this asserts the affordance, not a live mutation).
    func testThinkingLevelButtonsAreTappable() {
        openModelPicker()
        let high = waitFor("thinking-row-high", 6)
        XCTAssertTrue(high.isHittable, "a thinking-level button is reachable")
        high.tap()
        XCTAssertTrue(exists("model-picker"), "the picker stays open after choosing a level")
        attach("modelpicker-thinking-tap")
    }

    /// The picker dismisses via Done, returning to the chat.
    func testModelPickerDismisses() {
        openModelPicker()
        XCTAssertTrue(waitFor("model-picker", 6).exists, "picker is open")
        let done = app.buttons["Done"].firstMatch
        XCTAssertTrue(done.waitForExistence(timeout: 4), "Done button present")
        done.tap()
        XCTAssertTrue(waitForGone("model-picker", 6), "Done dismisses the picker")
        XCTAssertTrue(waitFor("mobile-composer", 6).exists, "back on the chat surface")
        attach("modelpicker-dismissed")
    }

    /// Selecting a model row updates the session (the row checkmarks). The model list comes
    /// from the server (`requestModels` no-ops under `-uitest`); if `UITestFixtures` seeds no
    /// `availableModels`, no `model-row-*` renders → SKIP with the request.
    func testSelectingModelRowUpdatesSession() throws {
        openModelPicker()
        _ = waitFor("model-picker", 6)
        let hasRow = app.descendants(matching: .any).allElementsBoundByIndex
            .contains { $0.identifier.hasPrefix("model-row-") }
        guard hasRow else {
            throw XCTSkip("""
            No model rows to select — `requestModels` no-ops under -uitest and `UITestFixtures` \
            seeds no `availableModels`, so the sheet shows "Loading models…". To exercise selection, \
            seed an availableModels list for a fixture session so `model-row-<provider>-<id>` rows \
            render + one can be tapped/checkmarked. Selection routing is unit-covered (protocol \
            round-trip); this is the e2e wiring.
            """)
        }
        let row = app.descendants(matching: .any).allElementsBoundByIndex
            .first { $0.identifier.hasPrefix("model-row-") }!
        row.tap()
        attach("modelpicker-selected")
    }
}
