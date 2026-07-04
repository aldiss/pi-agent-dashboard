import Foundation

/// UserDefaults-backed persistence for the operator's `ThemeMode`. Defaults to
/// `.dark` on a fresh install so the native app matches the (dark) PWA out of the
/// box — the operator's phone runs dark, and `.system` used to mis-render light.
/// `UserDefaults` is injectable so the round-trip is unit-testable via `swift test`
/// with an ephemeral suite (zero simulator dependency). Mirrors the
/// `ConnectionPreferences` / `MessageFilterStore` pattern already in the app. Never
/// throws; an unset or unrecognized stored value falls back to `.dark`.
public enum ThemeModeStore {
    private static let key = "pi.dashboard.themeMode"

    /// The default mode for a fresh install / corrupt value — dark, to match the PWA.
    public static let defaultMode: ThemeMode = .dark

    /// The persisted mode, or `defaultMode` (`.dark`) when unset / unrecognized.
    public static func load(from defaults: UserDefaults = .standard) -> ThemeMode {
        guard let raw = defaults.string(forKey: key), let mode = ThemeMode(rawValue: raw) else {
            return defaultMode
        }
        return mode
    }

    /// Persist the mode. All three modes are stored explicitly (including `.system`)
    /// so every choice round-trips — the default is now `.dark`, so "absent key" can
    /// no longer stand in for `.system` the way it did when `.system` was the default.
    public static func save(_ mode: ThemeMode, to defaults: UserDefaults = .standard) {
        defaults.set(mode.rawValue, forKey: key)
    }
}
