import XCTest

/// SETTINGS — THEME MODE (parity B5) — the Settings sheet exposes a System/Dark/Light
/// segmented picker (`settings-theme-picker`) that re-themes the app live and PERSISTS
/// across launches (`ThemeModeStore` → `pi.dashboard.themeMode`, default `.system`).
///
/// The picker selection is the deterministic observable (a segmented control reports
/// `isSelected` per segment); the rendered COLOR change is a property XCUITest can't read
/// off an element (the ComposerThemeUITests backfill carries the color-legibility
/// evidence via screenshots), so this asserts the SELECTION + its PERSISTENCE. The
/// persistence test relaunches WITHOUT arg-domain forcing to read the on-disk value back,
/// then RESTORES `.system` (clearing the key) so it never leaks into a sibling test.
@MainActor
final class SettingsThemeUITests: PiDashboardUITestCase {

    private func openSettings() {
        connectAndEnterList()
        waitFor("settings-button", 6).tap()
        _ = waitFor("settings-view", 6)
    }

    /// The theme picker renders with all three segments reachable.
    func testThemePickerShowsAllModes() {
        launch()
        openSettings()

        let picker = waitFor("settings-theme-picker", 6)
        XCTAssertTrue(picker.exists, "the theme picker renders in Settings")
        XCTAssertTrue(picker.buttons["System"].exists, "System segment present")
        XCTAssertTrue(picker.buttons["Dark"].exists, "Dark segment present")
        XCTAssertTrue(picker.buttons["Light"].exists, "Light segment present")
        attach("settings-theme-picker")
    }

    /// Choosing Light selects that segment live (the in-session switch). Forced to a
    /// known start (`themeMode: "dark"`) via the arg domain so the transition is
    /// deterministic; the arg domain is volatile (never written to disk).
    func testSwitchingToLightSelectsThatSegment() {
        launchForcing(themeMode: "dark")
        openSettings()

        let picker = waitFor("settings-theme-picker", 6)
        let light = picker.buttons["Light"]
        XCTAssertTrue(light.waitForExistence(timeout: 4), "Light segment present")
        light.tap()
        XCTAssertTrue(waitForSelected(picker, "Light"), "tapping Light selects the Light segment")
        attach("settings-theme-light-selected")
    }

    /// The theme choice survives an app relaunch: set Light, terminate, relaunch WITHOUT
    /// arg-domain forcing (so the persisted value is read), assert Light is still
    /// selected — then RESTORE System so the persisted key is cleared for siblings.
    func testThemePersistsAcrossRelaunch() {
        // Bare launch (no themeMode force) so the in-app choice is what persists.
        launch(["-uitest"])
        openSettings()
        let picker = waitFor("settings-theme-picker", 6)
        picker.buttons["Light"].tap()
        XCTAssertTrue(waitForSelected(picker, "Light"), "Light selected before relaunch")
        usleep(400_000) // let the ThemeModeStore write settle
        app.terminate()

        // Relaunch bare → the store loads the PERSISTED mode.
        launch(["-uitest"])
        openSettings()
        let picker2 = waitFor("settings-theme-picker", 6)
        XCTAssertTrue(waitForSelected(picker2, "Light"),
                      "the Light theme persisted across relaunch")
        attach("settings-theme-persisted")

        // Restore the default (clears pi.dashboard.themeMode) so nothing leaks downstream.
        picker2.buttons["System"].tap()
        XCTAssertTrue(waitForSelected(picker2, "System"), "restored to the System default")
    }

    // MARK: helpers

    /// Poll until `segment` in a segmented control reports selected (a tap posts the
    /// selection asynchronously). Deadline poll — Swift 6 strict-concurrency clean.
    private func waitForSelected(_ picker: XCUIElement, _ segment: String,
                                 _ timeout: TimeInterval = 5) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if picker.buttons[segment].isSelected { return true }
            usleep(150_000)
        }
        return picker.buttons[segment].isSelected
    }
}
