import Foundation

/// UserDefaults-backed persistence for the operator's `ThemeMode`. Defaults to
/// `.system` (follow the OS) on a fresh install. `UserDefaults` is injectable so the
/// round-trip is unit-testable via `swift test` with an ephemeral suite (zero
/// simulator dependency). Mirrors the `ConnectionPreferences` / `MessageFilterStore`
/// pattern already in the app. Never throws; an unknown stored value falls back to
/// `.system`.
public enum ThemeModeStore {
    private static let key = "pi.dashboard.themeMode"

    /// The persisted mode, or `.system` when unset / unrecognized.
    public static func load(from defaults: UserDefaults = .standard) -> ThemeMode {
        guard let raw = defaults.string(forKey: key), let mode = ThemeMode(rawValue: raw) else {
            return .system
        }
        return mode
    }

    /// Persist the mode. Saving `.system` clears the key (clean revert to default).
    public static func save(_ mode: ThemeMode, to defaults: UserDefaults = .standard) {
        if mode == .system {
            defaults.removeObject(forKey: key)
        } else {
            defaults.set(mode.rawValue, forKey: key)
        }
    }
}
