import Foundation

/// Persisted connection settings — server URL + optional bearer token — with a
/// baked-in default so a fresh install already points at the operator's dashboard.
/// UserDefaults-backed (mirrors `KnownServersStore`); the `UserDefaults` is
/// injectable so the load/save round-trip is unit-testable via `swift test` with
/// an ephemeral suite (zero simulator dependency).
public struct ConnectionPreferences: Equatable {
    /// Baked-in default server for a fresh install — the tunnel the multi-operator
    /// `pi_dash_token` cookie is domain-bound to. A raw Tailscale-IP origin can't carry
    /// the cookie (the WS would 401), so the app defaults its connect target here.
    /// Prefilled in the connect form; not treated as a "stored" server, so a fresh
    /// install still shows the editable connect screen rather than auto-connecting.
    public static let defaultServerURL = "https://dash.deckdeckshare.com"

    private static let urlKey = "pi.dashboard.serverURL"
    private static let tokenKey = "pi.dashboard.serverToken"

    public var serverURL: String
    public var token: String?

    public init(serverURL: String, token: String?) {
        self.serverURL = serverURL
        self.token = token
    }

    /// Persisted prefs, or the baked-in default when nothing is stored. An empty
    /// stored value is treated as absent.
    public static func load(from defaults: UserDefaults = .standard) -> ConnectionPreferences {
        let storedURL = defaults.string(forKey: urlKey)?.trimmingCharacters(in: .whitespaces)
        let storedToken = defaults.string(forKey: tokenKey)
        let url = (storedURL?.isEmpty == false) ? storedURL! : defaultServerURL
        let token = (storedToken?.isEmpty == false) ? storedToken : nil
        return ConnectionPreferences(serverURL: url, token: token)
    }

    /// True once a server URL has been persisted (i.e. a prior successful connect).
    /// Gates launch auto-connect: false on a fresh install → show the connect form.
    public static func hasStoredServer(in defaults: UserDefaults = .standard) -> Bool {
        (defaults.string(forKey: urlKey)?.trimmingCharacters(in: .whitespaces).isEmpty == false)
    }

    /// Persist the last good server. Trims the URL; an empty/nil token clears the
    /// stored token rather than writing an empty string.
    public static func save(serverURL: String, token: String?, to defaults: UserDefaults = .standard) {
        defaults.set(serverURL.trimmingCharacters(in: .whitespaces), forKey: urlKey)
        if let token, !token.isEmpty {
            defaults.set(token, forKey: tokenKey)
        } else {
            defaults.removeObject(forKey: tokenKey)
        }
    }

    /// Forget the persisted server + token (reverts to the baked-in default).
    public static func clear(from defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: urlKey)
        defaults.removeObject(forKey: tokenKey)
    }
}
