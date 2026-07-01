import Foundation

/// UserDefaults-backed persistence for the chat message filter — an app-level default
/// plus per-session overrides. Resolution when loading a session's filter:
///   1. the session's persisted override, if any;
///   2. else the app-level default, if the operator changed it;
///   3. else the canonical `MessageFilter.default`.
///
/// `UserDefaults` is injectable so the load/save round-trip is unit-testable via
/// `swift test` with an ephemeral suite (zero simulator dependency). Mirrors the
/// `ConnectionPreferences` / `KnownServersStore` pattern already in the app. Never
/// throws; a decode failure falls back to the resolved default.
public enum MessageFilterStore {
    private static let sessionKeyPrefix = "pi.dashboard.messageFilter."
    private static let defaultKey = "pi.dashboard.messageFilter.__default"

    private static func sessionKey(_ sessionId: String) -> String {
        sessionKeyPrefix + sessionId
    }

    private static func decode(_ data: Data?) -> MessageFilter? {
        guard let data else { return nil }
        return try? JSONDecoder().decode(MessageFilter.self, from: data)
    }

    // MARK: app-level default

    /// The app-level default filter — what a session with no override starts from.
    /// Falls back to the canonical `MessageFilter.default` when unset/corrupt.
    public static func loadDefault(from defaults: UserDefaults = .standard) -> MessageFilter {
        decode(defaults.data(forKey: defaultKey)) ?? .default
    }

    /// Persist the app-level default. Setting it back to the canonical default clears
    /// the key (so `loadDefault` cleanly reverts).
    public static func saveDefault(_ filter: MessageFilter, to defaults: UserDefaults = .standard) {
        if filter.isDefault {
            defaults.removeObject(forKey: defaultKey)
        } else if let data = try? JSONEncoder().encode(filter) {
            defaults.set(data, forKey: defaultKey)
        }
    }

    // MARK: per-session override

    /// Whether this session carries an explicit persisted override (drives whether a
    /// "reset to default" clears vs no-ops).
    public static func hasOverride(_ sessionId: String, in defaults: UserDefaults = .standard) -> Bool {
        !sessionId.isEmpty && defaults.data(forKey: sessionKey(sessionId)) != nil
    }

    /// Resolve the active filter for a session: session override → app default →
    /// canonical default. Never throws.
    public static func load(_ sessionId: String, from defaults: UserDefaults = .standard) -> MessageFilter {
        if !sessionId.isEmpty, let override = decode(defaults.data(forKey: sessionKey(sessionId))) {
            return override
        }
        return loadDefault(from: defaults)
    }

    /// Persist a session override.
    public static func save(_ sessionId: String, _ filter: MessageFilter,
                            to defaults: UserDefaults = .standard) {
        guard !sessionId.isEmpty, let data = try? JSONEncoder().encode(filter) else { return }
        defaults.set(data, forKey: sessionKey(sessionId))
    }

    /// Drop a session's override → next `load` resolves to the app/canonical default.
    public static func clear(_ sessionId: String, from defaults: UserDefaults = .standard) {
        guard !sessionId.isEmpty else { return }
        defaults.removeObject(forKey: sessionKey(sessionId))
    }
}
