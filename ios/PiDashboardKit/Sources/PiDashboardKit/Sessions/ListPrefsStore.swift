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
    private static let collapsedDirsKey = "pi.dashboard.collapsedDirs"
    private static let tierFoldKey = "pi.dashboard.tierFold"

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

    /// The set of COLLAPSED directory cwds (folders the operator folded shut). Default
    /// empty ⇒ every folder starts expanded. Stored as a plain `[String]`; read back as
    /// a `Set` for O(1) membership. Absent/garbage → empty set (never throws).
    public static func loadCollapsedDirs(from defaults: UserDefaults = .standard) -> Set<String> {
        guard let arr = defaults.array(forKey: collapsedDirsKey) as? [String] else { return [] }
        return Set(arr)
    }

    /// Persist the collapsed-dirs set. An EMPTY set clears the key (fresh read → the
    /// all-expanded default). Sorted on write for a stable on-disk representation.
    public static func saveCollapsedDirs(_ dirs: Set<String>, to defaults: UserDefaults = .standard) {
        if dirs.isEmpty {
            defaults.removeObject(forKey: collapsedDirsKey)
        } else {
            defaults.set(dirs.sorted(), forKey: collapsedDirsKey)
        }
    }

    /// The tier fold OFF-DEFAULT set (tier `rawValue`s flipped away from their default
    /// expand state — see `TierFold`). Empty ⇒ clean PWA defaults ({standing-crew,
    /// drivers, cell-executor} expanded, the rest collapsed). Absent/garbage → empty.
    public static func loadTierFold(from defaults: UserDefaults = .standard) -> Set<String> {
        guard let arr = defaults.array(forKey: tierFoldKey) as? [String] else { return [] }
        return Set(arr)
    }

    /// Persist the tier off-default set. EMPTY clears the key (fresh read → defaults).
    /// Sorted on write for a stable on-disk representation.
    public static func saveTierFold(_ tiers: Set<String>, to defaults: UserDefaults = .standard) {
        if tiers.isEmpty {
            defaults.removeObject(forKey: tierFoldKey)
        } else {
            defaults.set(tiers.sorted(), forKey: tierFoldKey)
        }
    }
}
