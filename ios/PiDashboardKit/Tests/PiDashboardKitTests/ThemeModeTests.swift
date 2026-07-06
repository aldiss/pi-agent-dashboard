import XCTest
@testable import PiDashboardKit

/// Theme mode (parity B5): the pure palette resolver + the `ThemeMode` persistence.
/// Verified via `swift test`, no simulator. The light palette hexes are lifted from
/// the PWA `index.css [data-theme="light"]` block.
final class ThemeModeTests: XCTestCase {

    // MARK: resolvePalette (mode + system appearance → concrete palette)

    func testResolveDarkAndLight() {
        XCTAssertEqual(DashboardTheme.resolvePalette(.dark, systemIsDark: false), DashboardTheme.dark)
        XCTAssertEqual(DashboardTheme.resolvePalette(.dark, systemIsDark: true), DashboardTheme.dark)
        XCTAssertEqual(DashboardTheme.resolvePalette(.light, systemIsDark: true), DashboardTheme.light)
        XCTAssertEqual(DashboardTheme.resolvePalette(.light, systemIsDark: false), DashboardTheme.light)
    }

    /// `.system` follows the OS: dark appearance → dark palette, light → light.
    func testResolveSystemFollowsOS() {
        XCTAssertEqual(DashboardTheme.resolvePalette(.system, systemIsDark: true), DashboardTheme.dark)
        XCTAssertEqual(DashboardTheme.resolvePalette(.system, systemIsDark: false), DashboardTheme.light)
    }

    // MARK: light palette fidelity (PWA [data-theme="light"])

    func testLightPaletteKeyHexes() {
        let l = DashboardTheme.light
        XCTAssertEqual(l.bgPrimary, "#ffffff")
        XCTAssertEqual(l.bgSecondary, "#fafafa")
        XCTAssertEqual(l.bgTertiary, "#f0f0f0")
        XCTAssertEqual(l.textPrimary, "#1a1a1a")
        XCTAssertEqual(l.textSecondary, "#444444")
        XCTAssertEqual(l.borderPrimary, "#e0e0e0")
        XCTAssertEqual(l.accentPrimary, "#2563eb", "light overrides accent-primary")
    }

    /// Cluster 3: the light-mode semantic accents are DARKENED from the dark values
    /// (no longer inherited) so they meet WCAG AA on white. This replaces the prior
    /// "inherits verbatim" contract — pure green/amber/cyan on #ffffff failed 3:1.
    func testLightAccentsDarkenedForAA() {
        let l = DashboardTheme.light, d = DashboardTheme.dark
        // Each accent DIFFERS from dark (darkened) — the intentional break.
        XCTAssertNotEqual(l.accentGreen, d.accentGreen)
        XCTAssertNotEqual(l.accentYellow, d.accentYellow)
        XCTAssertNotEqual(l.accentCyan, d.accentCyan)
        XCTAssertNotEqual(l.accentOrange, d.accentOrange)
        // The darkened light accents each meet AA (≥3:1 UI) on the light bg; the dark
        // ones (bright) do NOT on white — proving the fix.
        XCTAssertTrue(Contrast.meetsAA(foreground: l.accentGreen, background: l.bgPrimary, largeOrUI: true))
        XCTAssertFalse(Contrast.meetsAA(foreground: d.accentGreen, background: l.bgPrimary, largeOrUI: true),
                       "the OLD (dark) green would have failed on white")
        // accentPrimary stays blue-600 in both (it was already AA).
        XCTAssertEqual(l.accentPrimary, "#2563eb")
    }

    /// Light and dark are genuinely different palettes (guards against a copy-paste
    /// that left light == dark).
    func testLightDiffersFromDark() {
        XCTAssertNotEqual(DashboardTheme.light, DashboardTheme.dark)
        XCTAssertNotEqual(DashboardTheme.light.bgPrimary, DashboardTheme.dark.bgPrimary)
    }

    // MARK: ThemeMode enum

    func testThemeModeLabelsAndCases() {
        XCTAssertEqual(ThemeMode.allCases, [.system, .dark, .light])
        XCTAssertEqual(ThemeMode.system.label, "System")
        XCTAssertEqual(ThemeMode.dark.label, "Dark")
        XCTAssertEqual(ThemeMode.light.label, "Light")
    }

    // MARK: persistence (ephemeral UserDefaults)

    private func ephemeral() -> (UserDefaults, String) {
        let suite = "pi.dashboard.thememode.tests.\(UUID().uuidString)"
        return (UserDefaults(suiteName: suite)!, suite)
    }

    func testFreshInstallDefaultsToSystem() {
        let (d, suite) = ephemeral()
        defer { d.removePersistentDomain(forName: suite) }
        // Ratified default (RABLE §1.1): `.system` ("Auto"). The `.system`-renders-
        // light bug is fixed, so pass-1's `.dark` workaround is restored to `.system`.
        XCTAssertEqual(ThemeModeStore.load(from: d), .system)
        XCTAssertEqual(ThemeModeStore.defaultMode, .system)
    }

    /// All three modes persist explicitly and round-trip — including `.system`, which
    /// is no longer represented by an absent key now that `.dark` is the default.
    func testSaveLoadRoundTripsAllModes() {
        let (d, suite) = ephemeral()
        defer { d.removePersistentDomain(forName: suite) }
        ThemeModeStore.save(.light, to: d)
        XCTAssertEqual(ThemeModeStore.load(from: d), .light)
        ThemeModeStore.save(.dark, to: d)
        XCTAssertEqual(ThemeModeStore.load(from: d), .dark)
        ThemeModeStore.save(.system, to: d)
        XCTAssertEqual(ThemeModeStore.load(from: d), .system)
    }

    /// Choosing `.system` from a saved `.light` persists `.system` (does NOT revert to
    /// the `.dark` default) — the explicit-persist contract.
    func testSavingSystemPersistsExplicitly() {
        let (d, suite) = ephemeral()
        defer { d.removePersistentDomain(forName: suite) }
        ThemeModeStore.save(.light, to: d)
        ThemeModeStore.save(.system, to: d)
        XCTAssertEqual(ThemeModeStore.load(from: d), .system)
    }

    /// A corrupt stored value falls back to the `.system` default (never throws).
    func testUnknownStoredValueFallsBackToSystem() {
        let (d, suite) = ephemeral()
        defer { d.removePersistentDomain(forName: suite) }
        d.set("chartreuse", forKey: "pi.dashboard.themeMode")
        XCTAssertEqual(ThemeModeStore.load(from: d), .system)
    }
}
