import XCTest
import PiDashboardKit

/// SETTINGS — THEME MODE (parity B5) — the Settings sheet exposes a System/Dark/Light
/// segmented picker (`settings-theme-picker`) that re-themes the app live and PERSISTS
/// across launches (`ThemeModeStore` → `pi.dashboard.themeMode`, default `.system`).
///
/// No session-id dependency — runs against the fixture-booted list. The picker selection is
/// the deterministic observable (a segmented control reports `isSelected` per segment); the
/// rendered COLOR change is the ComposerTheme backfill's screenshot evidence. The persistence
/// test relaunches WITHOUT arg-domain forcing to read the on-disk value back, then RESTORES
/// `.system` (clearing the key) so it never leaks into a sibling test.
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

    /// Choosing Light selects that segment live (forced to a known start via the arg domain).
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

    /// The theme choice survives a relaunch: set Light, terminate, relaunch (fixtures, no
    /// themeMode force), assert still selected — then RESTORE System for siblings.
    func testThemePersistsAcrossRelaunch() {
        launch(Self.fixtureArgs) // no themeMode force → the in-app choice is what persists
        openSettings()
        let picker = waitFor("settings-theme-picker", 6)
        picker.buttons["Light"].tap()
        XCTAssertTrue(waitForSelected(picker, "Light"), "Light selected before relaunch")
        usleep(400_000) // let the ThemeModeStore write settle
        app.terminate()

        launch(Self.fixtureArgs)
        openSettings()
        let picker2 = waitFor("settings-theme-picker", 6)
        XCTAssertTrue(waitForSelected(picker2, "Light"), "the Light theme persisted across relaunch")
        attach("settings-theme-persisted")

        picker2.buttons["System"].tap()
        XCTAssertTrue(waitForSelected(picker2, "System"), "restored to the System default")
    }

    // MARK: helpers

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
