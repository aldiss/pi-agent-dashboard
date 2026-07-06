import Foundation

/// UserDefaults-backed persistence for the operator's `ThemeMode`. Defaults to
/// `.system` ("Auto") on a fresh install per the ratified design (RABLE §1.1) — the
/// `.system`-renders-light bug is fixed (view-level colorScheme read in `ThemedRoot`),
/// so system follows the OS correctly and, on a dark phone, renders the dark palette.
/// `UserDefaults` is injectable so the round-trip is unit-testable via `swift test`
/// with an ephemeral suite (zero simulator dependency). Mirrors the
/// `ConnectionPreferences` / `MessageFilterStore` pattern already in the app. Never
/// throws; an unset or unrecognized stored value falls back to `.system`.
public enum ThemeModeStore {
    private static let key = "pi.dashboard.themeMode"

    /// The default mode for a fresh install / corrupt value — `.system` (follow OS).
    public static let defaultMode: ThemeMode = .system

    /// The persisted mode, or `defaultMode` (`.system`) when unset / unrecognized.
    public static func load(from defaults: UserDefaults = .standard) -> ThemeMode {
        guard let raw = defaults.string(forKey: key), let mode = ThemeMode(rawValue: raw) else {
            return defaultMode
        }
        return mode
    }

    /// Persist the mode. All three modes are stored explicitly (including `.system`)
    /// so every choice round-trips.
    public static func save(_ mode: ThemeMode, to defaults: UserDefaults = .standard) {
        defaults.set(mode.rawValue, forKey: key)
    }
}
