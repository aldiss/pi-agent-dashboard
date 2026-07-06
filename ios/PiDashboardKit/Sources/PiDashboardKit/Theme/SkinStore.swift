import Foundation

/// UserDefaults-backed persistence for the operator's `Skin` — sister to
/// `ThemeModeStore`, same contract. Defaults to `.editorial` on a fresh install
/// (mirrors web `useSkin.ts` `DEFAULT_SKIN`), so the native app ships the hero look
/// out of the box. `UserDefaults` is injectable so the round-trip is unit-testable
/// via `swift test` with an ephemeral suite (zero simulator dependency). Never
/// throws; an unset or unrecognized stored value falls back to `.editorial`.
public enum SkinStore {
    private static let key = "pi.dashboard.skin"

    /// The default skin for a fresh install / corrupt value — editorial (the hero).
    public static let defaultSkin: Skin = .editorial

    /// The persisted skin, or `defaultSkin` (`.editorial`) when unset / unrecognized.
    public static func load(from defaults: UserDefaults = .standard) -> Skin {
        guard let raw = defaults.string(forKey: key), let skin = Skin(rawValue: raw) else {
            return defaultSkin
        }
        return skin
    }

    /// Persist the skin explicitly (both cases stored) so every choice round-trips.
    public static func save(_ skin: Skin, to defaults: UserDefaults = .standard) {
        defaults.set(skin.rawValue, forKey: key)
    }
}
