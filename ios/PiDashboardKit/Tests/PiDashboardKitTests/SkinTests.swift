import XCTest
@testable import PiDashboardKit

/// BUILD-1 substrate: the `Skin` axis, its persistence, the skin×mode palette
/// resolver, the editorial-suppresses-named-theme composition rule, and hex fidelity
/// for the new editorial palettes. Pure `swift test`, no simulator. Editorial hexes
/// cross-checked own-hand against `packages/client/src/index.css` editorial blocks.
final class SkinTests: XCTestCase {

    // MARK: defaults (fresh install = editorial + system)

    private func ephemeral() -> (UserDefaults, String) {
        let suite = "pi.dashboard.skin.tests.\(UUID().uuidString)"
        return (UserDefaults(suiteName: suite)!, suite)
    }

    func testFreshInstallDefaultsToEditorial() {
        let (d, suite) = ephemeral()
        defer { d.removePersistentDomain(forName: suite) }
        XCTAssertEqual(SkinStore.load(from: d), .editorial)
        XCTAssertEqual(SkinStore.defaultSkin, .editorial)
    }

    /// The two appearance axes together: a fresh install is editorial + system — the
    /// ratified hero default (dark phone → editorial-dark render).
    func testFreshInstallAppearanceIsEditorialSystem() {
        let (d, suite) = ephemeral()
        defer { d.removePersistentDomain(forName: suite) }
        XCTAssertEqual(SkinStore.load(from: d), .editorial)
        XCTAssertEqual(ThemeModeStore.load(from: d), .system)
    }

    // MARK: persistence (ephemeral UserDefaults)

    func testSkinRoundTripsBothSkins() {
        let (d, suite) = ephemeral()
        defer { d.removePersistentDomain(forName: suite) }
        SkinStore.save(.legacy, to: d)
        XCTAssertEqual(SkinStore.load(from: d), .legacy)
        SkinStore.save(.editorial, to: d)
        XCTAssertEqual(SkinStore.load(from: d), .editorial)
    }

    func testUnknownStoredSkinFallsBackToEditorial() {
        let (d, suite) = ephemeral()
        defer { d.removePersistentDomain(forName: suite) }
        d.set("brutalist", forKey: "pi.dashboard.skin")
        XCTAssertEqual(SkinStore.load(from: d), .editorial)
    }

    func testSkinEnumLabelsAndCases() {
        XCTAssertEqual(Skin.allCases, [.editorial, .legacy])
        XCTAssertEqual(Skin.editorial.label, "Editorial")
        XCTAssertEqual(Skin.legacy.label, "Legacy")
    }

    // MARK: resolvePalette(skin, mode, systemIsDark) — the 4 base combos

    func testResolveEditorialModes() {
        XCTAssertEqual(DashboardTheme.resolvePalette(.editorial, .dark, systemIsDark: false),
                       DashboardTheme.editorialDark)
        XCTAssertEqual(DashboardTheme.resolvePalette(.editorial, .light, systemIsDark: true),
                       DashboardTheme.editorialLight)
    }

    func testResolveLegacyModes() {
        XCTAssertEqual(DashboardTheme.resolvePalette(.legacy, .dark, systemIsDark: false),
                       DashboardTheme.dark)
        XCTAssertEqual(DashboardTheme.resolvePalette(.legacy, .light, systemIsDark: true),
                       DashboardTheme.light)
    }

    /// `.system` composes with skin: dark OS → the skin's dark palette, light OS → the
    /// skin's light palette — for BOTH skins.
    func testResolveSystemFollowsOSPerSkin() {
        XCTAssertEqual(DashboardTheme.resolvePalette(.editorial, .system, systemIsDark: true),
                       DashboardTheme.editorialDark)
        XCTAssertEqual(DashboardTheme.resolvePalette(.editorial, .system, systemIsDark: false),
                       DashboardTheme.editorialLight)
        XCTAssertEqual(DashboardTheme.resolvePalette(.legacy, .system, systemIsDark: true),
                       DashboardTheme.dark)
        XCTAssertEqual(DashboardTheme.resolvePalette(.legacy, .system, systemIsDark: false),
                       DashboardTheme.light)
    }

    /// The legacy branch delegates to the pass-1 mode-axis resolver — same result as
    /// the 2-arg form, so the mode logic stays single-sourced.
    func testLegacyDelegatesToModeResolver() {
        for mode in ThemeMode.allCases {
            for isDark in [true, false] {
                XCTAssertEqual(DashboardTheme.resolvePalette(.legacy, mode, systemIsDark: isDark),
                               DashboardTheme.resolvePalette(mode, systemIsDark: isDark))
            }
        }
    }

    // MARK: composition rule stub — editorial suppresses named themes

    func testEditorialSuppressesNamedThemeToBase() {
        // Editorial owns its palette → any requested named theme resolves to "base".
        XCTAssertEqual(DashboardTheme.effectiveThemeName(.editorial, "dracula"), "base")
        XCTAssertEqual(DashboardTheme.effectiveThemeName(.editorial, "nord"), "base")
        XCTAssertEqual(DashboardTheme.effectiveThemeName(.editorial, "base"), "base")
    }

    func testLegacyPassesNamedThemeThrough() {
        // Legacy lets a named theme through (the axis where the 9 themes will land).
        XCTAssertEqual(DashboardTheme.effectiveThemeName(.legacy, "dracula"), "dracula")
        XCTAssertEqual(DashboardTheme.effectiveThemeName(.legacy, "base"), "base")
    }

    // MARK: editorial palette hex fidelity (index.css :94–189, own-hand)

    func testEditorialDarkKeyHexes() {
        let e = DashboardTheme.editorialDark
        XCTAssertEqual(e.bgPrimary, "#17120e")
        XCTAssertEqual(e.bgSecondary, "#1e1813")
        XCTAssertEqual(e.bgTertiary, "#251d16")
        XCTAssertEqual(e.bgSurface, "#2e251c")
        XCTAssertEqual(e.bgCode, "#1a130d")
        XCTAssertEqual(e.textPrimary, "#f3ebe0")
        XCTAssertEqual(e.textSecondary, "#c9bbab")
        XCTAssertEqual(e.textTertiary, "#9b8b78")
        XCTAssertEqual(e.textMuted, "#897a67")
        XCTAssertEqual(e.textFaint, "#5a4d3f")
        XCTAssertEqual(e.borderPrimary, "#2c2219")
        XCTAssertEqual(e.borderSecondary, "#3a2f24")
        // Terracotta is the interactive accent — NOT blue — under editorial.
        XCTAssertEqual(e.accentPrimary, "#cf6238")
        XCTAssertEqual(e.accentBlue, "#cf6238")
        XCTAssertEqual(e.link, "#cf6238")
        XCTAssertEqual(e.linkHover, "#e6926a")
    }

    /// Editorial status hues (softer than legacy Tailwind), folded onto the accent
    /// fields the existing `status*` computed vars read (statusWorking→accentYellow…).
    func testEditorialDarkStatusHuesResolve() {
        let e = DashboardTheme.editorialDark
        XCTAssertEqual(e.accentGreen, "#7fae5a")
        XCTAssertEqual(e.accentPurple, "#b283d6")
        XCTAssertEqual(e.accentYellow, "#e0a23c")
        XCTAssertEqual(e.accentCyan, "#5ba9a0")
        XCTAssertEqual(e.accentRed, "#d65440")
        // The semantic computed vars therefore resolve to the editorial hues.
        XCTAssertEqual(e.statusWorking, "#e0a23c")   // → accentYellow
        XCTAssertEqual(e.statusActive, "#7fae5a")    // → accentGreen
        XCTAssertEqual(e.statusNeedsInput, "#b283d6")// → accentPurple
        XCTAssertEqual(e.statusUnread, "#5ba9a0")    // → accentCyan
        XCTAssertEqual(e.statusError, "#d65440")     // → accentRed
    }

    func testEditorialLightKeyHexes() {
        let e = DashboardTheme.editorialLight
        XCTAssertEqual(e.bgPrimary, "#f4ece1")   // warm paper, NOT cold white
        XCTAssertEqual(e.bgTertiary, "#fbf5ec")
        XCTAssertEqual(e.bgSurface, "#ffffff")
        XCTAssertEqual(e.textPrimary, "#2a211a")
        XCTAssertEqual(e.textSecondary, "#5e5042")
        XCTAssertEqual(e.textTertiary, "#80715e")
        XCTAssertEqual(e.accentPrimary, "#bb5630") // deepened terracotta for paper
        XCTAssertEqual(e.link, "#bb5630")
        XCTAssertEqual(e.shadowCard, "rgba(70,45,20,0.12)")
    }

    // MARK: 6 new structural tokens populated across ALL FOUR palettes

    func testAllPalettesPopulateNewStructuralTokens() {
        for p in [DashboardTheme.editorialDark, DashboardTheme.editorialLight,
                  DashboardTheme.dark, DashboardTheme.light] {
            XCTAssertFalse(p.bgHover.isEmpty)
            XCTAssertFalse(p.bgOverlay.isEmpty)
            XCTAssertFalse(p.textMuted.isEmpty)
            XCTAssertFalse(p.link.isEmpty)
            XCTAssertFalse(p.linkHover.isEmpty)
            XCTAssertFalse(p.shadowCard.isEmpty)
        }
    }

    /// Legacy tokens keep their pass-1 values (lifted from index.css legacy blocks).
    func testLegacyNewTokenValues() {
        let d = DashboardTheme.dark
        XCTAssertEqual(d.bgHover, "rgba(255,255,255,0.06)")
        XCTAssertEqual(d.bgOverlay, "rgba(0,0,0,0.6)")
        XCTAssertEqual(d.textMuted, "#585858")
        XCTAssertEqual(d.link, "#60a5fa")
        XCTAssertEqual(d.linkHover, "#93bbfd")
        XCTAssertEqual(d.shadowCard, "rgba(0,0,0,0.4)")
    }

    /// All four base palettes are genuinely distinct (guards a copy-paste that left
    /// two identical).
    func testFourPalettesDiffer() {
        let all = [DashboardTheme.editorialDark, DashboardTheme.editorialLight,
                   DashboardTheme.dark, DashboardTheme.light]
        for i in all.indices {
            for j in all.indices where j > i {
                XCTAssertNotEqual(all[i], all[j])
            }
        }
    }
}
