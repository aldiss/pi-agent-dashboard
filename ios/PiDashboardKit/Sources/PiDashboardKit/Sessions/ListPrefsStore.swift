import Foundation

/// UserDefaults-backed persistence for session-list filter preferences. Currently
/// just the DF#2 "hide ended" toggle (default ON — ended crew tenures flood the
/// list). `UserDefaults` is injectable so the round-trip is unit-testable via
/// `swift test` with an ephemeral suite. Mirrors the `ThemeModeStore` /
/// `MessageFilterStore` pattern. Never throws.
///
/// NOTE: the other list toggles (Hide stale / Hidden / Folders) are in-memory only
/// by prior design; only `hideEnded` is persisted (per the DF#2 brief). New list
/// prefs that need persistence get added here.
public enum ListPrefsStore {
    private static let hideEndedKey = "pi.dashboard.hideEnded"

    /// Whether ended sessions are hidden — default `true` on a fresh install.
    /// Stored only when it DIFFERS from the default, so `true` ⇒ (absent OR "true").
    public static func loadHideEnded(from defaults: UserDefaults = .standard) -> Bool {
        guard defaults.object(forKey: hideEndedKey) != nil else { return true }
        return defaults.bool(forKey: hideEndedKey)
    }

    /// Persist the hide-ended toggle. Saving the default (`true`) clears the key so a
    /// fresh read resolves back to the default.
    public static func saveHideEnded(_ hideEnded: Bool, to defaults: UserDefaults = .standard) {
        if hideEnded {
            defaults.removeObject(forKey: hideEndedKey)
        } else {
            defaults.set(false, forKey: hideEndedKey)
        }
    }
}
