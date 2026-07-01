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

    /// The semantic accents INHERIT the dark values in light mode (the PWA light
    /// block leaves them untouched) — so the session/chat color language is stable.
    func testLightInheritsSemanticAccents() {
        let l = DashboardTheme.light, d = DashboardTheme.dark
        XCTAssertEqual(l.accentBlue, d.accentBlue)
        XCTAssertEqual(l.accentGreen, d.accentGreen)
        XCTAssertEqual(l.accentRed, d.accentRed)
        XCTAssertEqual(l.accentYellow, d.accentYellow)
        XCTAssertEqual(l.accentPurple, d.accentPurple)
        XCTAssertEqual(l.accentCyan, d.accentCyan)
        // Semantic status accents therefore also match across modes.
        XCTAssertEqual(l.statusActive, d.statusActive)
        XCTAssertEqual(l.statusWorking, d.statusWorking)
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
        XCTAssertEqual(ThemeModeStore.load(from: d), .system)
    }

    func testSaveLoadRoundTrips() {
        let (d, suite) = ephemeral()
        defer { d.removePersistentDomain(forName: suite) }
        ThemeModeStore.save(.light, to: d)
        XCTAssertEqual(ThemeModeStore.load(from: d), .light)
        ThemeModeStore.save(.dark, to: d)
        XCTAssertEqual(ThemeModeStore.load(from: d), .dark)
    }

    /// Saving `.system` clears the key → load resolves back to `.system`.
    func testSavingSystemClearsKey() {
        let (d, suite) = ephemeral()
        defer { d.removePersistentDomain(forName: suite) }
        ThemeModeStore.save(.dark, to: d)
        ThemeModeStore.save(.system, to: d)
        XCTAssertEqual(ThemeModeStore.load(from: d), .system)
    }

    /// A corrupt stored value falls back to `.system` (never throws).
    func testUnknownStoredValueFallsBackToSystem() {
        let (d, suite) = ephemeral()
        defer { d.removePersistentDomain(forName: suite) }
        d.set("chartreuse", forKey: "pi.dashboard.themeMode")
        XCTAssertEqual(ThemeModeStore.load(from: d), .system)
    }
}
