import Foundation

/// Per-session last-read-position persistence (DF#3). Stores the id of the last
/// message the operator had read, so re-opening a session restores that scroll
/// position instead of jumping to the end. LOCAL-first: `UserDefaults`, behind this
/// clean enum abstraction so it can move to server-sync later without touching call
/// sites. `UserDefaults` is injectable → the round-trip is `swift test`-able with an
/// ephemeral suite. Mirrors the `MessageFilterStore` / `ListPrefsStore` pattern.
/// Never throws.
public enum ReadPositionStore {
    private static let keyPrefix = "pi.dashboard.readPosition."

    private static func key(_ sessionId: String) -> String { keyPrefix + sessionId }

    /// The last-read message id for a session, or nil when never read (→ everything
    /// counts as unread; the view restores to the first unread / start).
    public static func load(_ sessionId: String, from defaults: UserDefaults = .standard) -> String? {
        guard !sessionId.isEmpty else { return nil }
        let v = defaults.string(forKey: key(sessionId))
        return (v?.isEmpty == false) ? v : nil
    }

    /// Persist the last-read message id. An empty id clears the mark.
    public static func save(_ sessionId: String, messageId: String,
                            to defaults: UserDefaults = .standard) {
        guard !sessionId.isEmpty else { return }
        if messageId.isEmpty {
            defaults.removeObject(forKey: key(sessionId))
        } else {
            defaults.set(messageId, forKey: key(sessionId))
        }
    }

    /// Forget a session's read position (→ next open restores to first unread / start).
    public static func clear(_ sessionId: String, from defaults: UserDefaults = .standard) {
        guard !sessionId.isEmpty else { return }
        defaults.removeObject(forKey: key(sessionId))
    }
}
