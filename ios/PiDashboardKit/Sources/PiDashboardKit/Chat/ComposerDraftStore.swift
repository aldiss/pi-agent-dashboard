import Foundation

/// Per-session composer text persistence. Images intentionally stay in memory: they
/// survive navigation but not process relaunch, matching the PWA's retention boundary.
public enum ComposerDraftStore {
    private static let prefix = "pi-dashboard.composer-draft."

    public static func load(sessionId: String, defaults: UserDefaults = .standard) -> String {
        defaults.string(forKey: prefix + sessionId) ?? ""
    }

    public static func save(_ text: String, sessionId: String,
                            defaults: UserDefaults = .standard) {
        let key = prefix + sessionId
        if text.isEmpty { defaults.removeObject(forKey: key) }
        else { defaults.set(text, forKey: key) }
    }
}
