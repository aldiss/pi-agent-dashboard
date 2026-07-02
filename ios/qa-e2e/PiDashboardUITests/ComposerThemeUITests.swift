import XCTest
import PiDashboardKit

/// BACKFILL #1 — the composer renders, is interactable, and shows READABLE text in
/// BOTH light and dark themes. Regression guard for the operator-reported light-mode
/// wash-out (`fix(ios): make the composer input theme-aware`, c7acd19): before the
/// fix, `GrowingTextView` hardcoded dark-mode UIKit colors (text `white:0.9`,
/// keyboard `.dark`), so in LIGHT mode the typed text was near-invisible gray on a
/// light card and the keyboard stayed dark.
///
/// What an XCUITest CAN assert about "readable" (structure + behavior, deterministic):
///   • the composer + its `mobile-composer-textarea` mount in this theme,
///   • the field is interactable — a typed string ROUND-TRIPS back as its value
///     (a broken/washed-out field that dropped focus would not),
///   • send-gating reacts to that text (empty → disabled, non-empty → enabled),
/// and it attaches a screenshot in each theme as the COLOR evidence (a pure
/// text-color regression is a rendering property XCUITest can't read off an element,
/// per the repo's "verify by rendering" rule — the attachment is the artifact the
/// operator/SwiftPilot eyeballs). Theme is forced hermetically through the
/// `UserDefaults` argument domain (`launchForcing`) — no app-side test hook.
@MainActor
final class ComposerThemeUITests: PiDashboardUITestCase {

    /// Open a fixture session's chat in a forced theme and return the up composer's
    /// textarea. Any fixture session's composer exercises the same theme-aware input.
    @discardableResult
    private func openComposer(themeMode: String) -> XCUIElement {
        launchForcing(themeMode: themeMode)
        connectAndEnterList()
        openChat(fixtureSessions.first ?? fixtureSession("any") { _ in true })
        return waitFor("mobile-composer-textarea", 8)
    }

    /// Assert the composer is live + text is retained (readable-proxy) in `themeMode`.
    /// Shared body so light and dark run the IDENTICAL contract — only the theme (and
    /// so the rendered colors, captured in the screenshot) differ.
    private func assertComposerInteractableAndReadable(themeMode: String) {
        let textView = openComposer(themeMode: themeMode)
        XCTAssertTrue(waitForComposerLayout("single-row"), "composer starts single-row in \(themeMode)")

        // Send starts disabled (empty composer) — the gating baseline.
        let send = waitFor("mobile-composer-send", 6)
        XCTAssertFalse(send.isEnabled, "send disabled on an empty composer (\(themeMode))")

        // Type into the field; the value must ROUND-TRIP — proves the input is live
        // and holding text in this theme (the washed-out field still holds text, but
        // this is the behavioral half; the screenshot is the color half).
        let probe = "readable in \(themeMode)"
        textView.tap()
        textView.typeText(probe)
        XCTAssertTrue(valueContains(textView, probe, timeout: 4),
                      "typed text round-trips in the \(themeMode) composer (field is live)")

        // Send flips enabled once there's non-whitespace text — the composer is
        // processing input, not inert, in this theme.
        XCTAssertTrue(send.isEnabled, "send enabled after typing in \(themeMode)")

        // COLOR evidence: attach the rendered composer in this theme for the
        // render-and-look verification step (text must be legible, not washed out).
        attach("composer-\(themeMode)")
    }

    // MARK: dark (the shipped default — must stay readable)

    func testComposerReadableInDarkTheme() {
        assertComposerInteractableAndReadable(themeMode: "dark")
    }

    // MARK: light (the wash-out regression the fix guards)

    func testComposerReadableInLightTheme() {
        assertComposerInteractableAndReadable(themeMode: "light")
    }

    // MARK: live theme switch (the updateUIView re-apply path)

    /// The fix re-applies theme colors in `GrowingTextView.updateUIView` (not just
    /// `makeUIView`) so a LIVE `ThemeController` switch recolors text + placeholder +
    /// keyboard without a remount. Drive that path end-to-end: open the composer in
    /// dark, switch the app theme to Light via Settings, reopen the composer, and
    /// assert it is STILL interactable + readable (text round-trips) — a regression
    /// here (e.g. colors only applied at make-time) would strand washed-out text after
    /// the switch. Fully hermetic (fixture mode; Settings toggle is in-app).
    func testComposerSurvivesLiveThemeSwitchToLight() {
        // Start in dark and confirm the composer is healthy.
        let textView = openComposer(themeMode: "dark")
        textView.tap()
        textView.typeText("before switch")
        XCTAssertTrue(valueContains(textView, "before switch", timeout: 4),
                      "composer live in dark before the switch")
        attach("composer-liveswitch-dark")

        // Back to the list → open Settings → pick Light on the theme segmented picker.
        let back = app.navigationBars.buttons.firstMatch
        if back.exists { back.tap() }
        waitFor("session-list", 8)
        waitFor("settings-button", 6).tap()
        let picker = waitFor("settings-theme-picker", 6)
        // Segmented control: the "Light" segment is a button inside the picker.
        let lightSegment = picker.buttons["Light"]
        XCTAssertTrue(lightSegment.waitForExistence(timeout: 4), "Light theme segment present")
        lightSegment.tap()
        attach("settings-theme-light")
        waitFor("settings-done", 4).tap()

        // Reopen the chat → the composer must still be interactable + hold text in the
        // freshly-applied light theme (the live re-apply worked).
        openChat(fixtureSessions.first ?? fixtureSession("any") { _ in true })
        let tv2 = waitFor("mobile-composer-textarea", 8)
        tv2.tap()
        tv2.typeText("after switch")
        XCTAssertTrue(valueContains(tv2, "after switch", timeout: 4),
                      "composer still live + readable after switching to light")
        let send = waitFor("mobile-composer-send", 6)
        XCTAssertTrue(send.isEnabled, "send enabled in the switched-to light theme")
        attach("composer-liveswitch-light")
    }

    // MARK: helpers

    /// Poll a text element's `value` until it contains `substring` (SwiftUI/UIKit
    /// posts the a11y value asynchronously after a `typeText`). No self-capturing
    /// NSPredicate — Swift 6 strict-concurrency clean.
    private func valueContains(_ element: XCUIElement, _ substring: String,
                               timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let v = element.value as? String, v.contains(substring) { return true }
            usleep(150_000)
        }
        return (element.value as? String)?.contains(substring) ?? false
    }
}
