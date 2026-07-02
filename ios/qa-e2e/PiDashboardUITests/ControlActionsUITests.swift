import XCTest
import PiDashboardKit

/// F1–F7 EXTENSION — the control actions (abort / resume / spawn), the message-type
/// filter, and settings reachability. The night-1 F1–F7 covered connect / list / open
/// chat / composer / banner / search-folders-stale; this deepens the SAME flows with
/// the lifecycle controls the brief calls out (abort/resume/spawn) plus the chat
/// message-type filter.
///
/// Discipline: the control MUTATIONS (abort/resume/spawn) deliberately no-op under
/// `-uitest` (DashboardStore guards each with `!isUITest` so the suite can never touch
/// a live operator session), so these specs assert the AFFORDANCE contract —
/// presence in the correct session state, reachability, confirm-dialog wiring, sheet
/// presentation, and in-app (non-mutating) state flips like the filter pills. That is
/// the same honest boundary the F7 hide-stale test documents (assert the toggle
/// contract, not a live effect). Fully hermetic (`-uitest` fixture mode).
@MainActor
final class ControlActionsUITests: PiDashboardUITestCase {

    // MARK: F — abort (Stop) affordance on a running session

    /// A RUNNING session (a `streaming` fixture session) shows the Stop control in the
    /// chat toolbar; tapping it opens the confirm dialog (`chat-abort-confirm`). Cancel
    /// dismisses without mutating (abort no-ops under `-uitest` regardless).
    func testAbortAffordanceShowsAndConfirms() {
        launch()
        connectAndEnterList()
        openChat(fixtureSession(status: "streaming"))

        let stop = waitFor("chat-abort-button", 6)
        XCTAssertTrue(stop.isHittable, "Stop shows + is reachable on a running session")
        attach("ext-abort-button")

        stop.tap()
        XCTAssertTrue(waitFor("chat-abort-confirm", 5).exists,
                      "tapping Stop opens the abort confirmation dialog")
        attach("ext-abort-confirm")

        // Dismiss without stopping (Cancel role button on the confirmation sheet).
        let cancel = app.buttons["Cancel"].firstMatch
        if cancel.waitForExistence(timeout: 3) { cancel.tap() }
    }

    // MARK: F — resume affordance on an ended session

    /// An ended fixture session's card exposes a Resume control (`card-resume-button`) —
    /// shown ONLY for `status == "ended"`. Reveal it via `hideEnded` off + a narrowing
    /// search (the worker tier can sit below the fold), then assert the affordance.
    func testResumeAffordanceShowsOnEndedSession() {
        launchForcing(hideEnded: false)
        connectAndEnterList()

        let ended = fixtureSession(status: "ended")
        let field = waitFor("list-search")
        field.tap()
        field.typeText(ended.displayName)

        XCTAssertTrue(waitFor(cardId(ended), 6).exists, "the ended card is shown")
        XCTAssertTrue(waitForAppear("card-resume-button", 6),
                      "an ended session exposes the Resume control")
        attach("ext-resume-button")
    }

    // MARK: F — spawn sheet (new session in a known directory)

    /// The "+ New session" toolbar control opens the spawn sheet listing KNOWN
    /// directories (`new-session-dir-<basename>`). Assert the sheet opens + at least
    /// one directory row is offered (spawn itself no-ops under `-uitest`).
    func testSpawnSheetListsKnownDirectories() {
        launch()
        connectAndEnterList()

        waitFor("new-session-button", 6).tap()
        XCTAssertTrue(waitFor("new-session-sheet", 6).exists, "the new-session sheet opens")

        let hasDirRow = app.descendants(matching: .any).allElementsBoundByIndex
            .contains { $0.identifier.hasPrefix("new-session-dir-") }
        XCTAssertTrue(hasDirRow, "the spawn sheet offers at least one known directory")
        attach("ext-spawn-sheet")

        let done = app.buttons["Done"].firstMatch
        if done.waitForExistence(timeout: 3) { done.tap() }
    }

    // MARK: F — message-type filter (pill flips in-app)

    /// The chat message-type filter: the toolbar filter button reveals the pill row
    /// (`chat-filter-controls`); tapping a pill flips its on/off value (persisted
    /// per-session in-app — no network). Reads the CURRENT value then asserts it
    /// inverts, robust to whatever the canonical default is for the category.
    func testMessageFilterPillToggles() {
        launch()
        connectAndEnterList()
        openChatBearing() // a chat with content → the pills have counts

        waitFor("chat-filter-button", 6).tap()
        XCTAssertTrue(waitFor("chat-filter-controls", 6).exists, "the filter pill row expands")

        let pill = waitFor("chat-filter-pill-toolCalls", 6)
        let before = pill.value as? String
        XCTAssertNotNil(before, "the pill exposes an on/off value")
        attach("ext-filter-controls")

        pill.tap()
        let want = before == "on" ? "off" : "on"
        // Poll the value flip (a11y value updates async after the tap).
        let deadline = Date().addingTimeInterval(4)
        var flipped = false
        while Date() < deadline {
            if (pill.value as? String) == want { flipped = true; break }
            usleep(150_000)
        }
        XCTAssertTrue(flipped, "tapping a filter pill flips its state \(before ?? "?")→\(want)")
    }

    // MARK: F — settings reachability (theme + done round-trip)

    /// The settings gear opens the Settings sheet (`settings-view`) exposing the theme
    /// picker; Done dismisses back to the list. Reachability round-trip (the theme
    /// SWITCH effect is covered by ComposerThemeUITests).
    func testSettingsOpensAndDismisses() {
        launch()
        connectAndEnterList()

        waitFor("settings-button", 6).tap()
        XCTAssertTrue(waitFor("settings-view", 6).exists, "the settings sheet opens")
        XCTAssertTrue(waitFor("settings-theme-picker", 4).exists, "the theme picker is present")
        attach("ext-settings")

        waitFor("settings-done", 4).tap()
        XCTAssertTrue(waitFor("session-list", 6).exists, "Done returns to the session list")
    }
}
