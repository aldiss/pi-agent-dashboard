import Foundation

/// The visual **skin** — an axis independent of the light/dark `ThemeMode`. Composes
/// with mode: `skin × mode` → one of four base palettes. Mirrors the web
/// `useSkin.ts` (`Skin = "editorial" | "legacy"`, `DEFAULT_SKIN = "editorial"`).
///   - `.editorial` (**default**): the warm "Editorial Craft" look — espresso-dark
///     hero + warm-paper light, terracotta interactive accent, softened status hues.
///   - `.legacy`: today's flat-gray system look, byte-for-byte the pass-1 palettes.
/// Persisted via `SkinStore`; resolved to a concrete `ThemePalette` by
/// `DashboardTheme.resolvePalette(skin, mode, systemIsDark)`.
public enum Skin: String, Sendable, Equatable, CaseIterable, Codable {
    case editorial, legacy

    /// Label for the (later) settings picker.
    public var label: String {
        switch self {
        case .editorial: return "Editorial"
        case .legacy:    return "Legacy"
        }
    }
}

public extension DashboardTheme {
    /// Resolve `skin × mode (+ OS appearance for `.system`)` to the concrete palette
    /// the UI renders — the four base combos:
    ///   editorial×dark → `editorialDark` · editorial×light → `editorialLight` ·
    ///   legacy×dark → `dark` · legacy×light → `light`.
    /// The legacy branch delegates to the existing mode-axis resolver (pass-1), so the
    /// mode logic stays single-sourced; editorial picks its own paper/espresso pair.
    /// Pure — `swift test`-able without a simulator.
    static func resolvePalette(_ skin: Skin, _ mode: ThemeMode, systemIsDark: Bool) -> ThemePalette {
        switch skin {
        case .legacy:
            return resolvePalette(mode, systemIsDark: systemIsDark)
        case .editorial:
            let isDark = mode == .dark || (mode == .system && systemIsDark)
            return isDark ? editorialDark : editorialLight
        }
    }

    /// Composition rule for the (deferred) **named-theme** axis, ported from
    /// `useTheme.ts:53–64`: the editorial skin OWNS its palette, so ANY named theme is
    /// suppressed and resolves to `"base"`; only `.legacy` lets a named theme through.
    ///
    /// Named themes (dracula / nord / …) are DEFERRED — only `"base"` ships in this
    /// unit. This is the single extension point they will land behind: when the 9
    /// themes arrive, `.legacy` returns the requested id and a lookup maps it to a
    /// palette; editorial keeps returning `"base"`. Keeping it a `String` (not an enum)
    /// mirrors the web's string-id model faithfully and avoids a premature taxonomy.
    static func effectiveThemeName(_ skin: Skin, _ requested: String) -> String {
        skin == .editorial ? "base" : requested
    }
}
