import Foundation

/// The operator's theme preference. `system` follows the OS light/dark setting;
/// `dark` / `light` pin a mode regardless. Persisted via `ThemeModeStore`; resolved
/// to a concrete `ThemePalette` by `DashboardTheme.resolvePalette`.
public enum ThemeMode: String, Sendable, Equatable, CaseIterable, Codable {
    case system, dark, light

    /// Label for the settings picker.
    public var label: String {
        switch self {
        case .system: return "System"
        case .dark:   return "Dark"
        case .light:  return "Light"
        }
    }
}

public extension DashboardTheme {
    /// Resolve a `ThemeMode` (+ the current OS appearance, for `.system`) to the
    /// concrete palette the UI renders. Pure — `swift test`-able without a simulator.
    ///   `.dark` → dark · `.light` → light · `.system` → dark when `systemIsDark`,
    ///   else light.
    static func resolvePalette(_ mode: ThemeMode, systemIsDark: Bool) -> ThemePalette {
        switch mode {
        case .dark:   return dark
        case .light:  return light
        case .system: return systemIsDark ? dark : light
        }
    }
}
