import Foundation
import Security

/// Keychain-backed store for the `pi_dash_token` JWT cookie — the operator's dashboard
/// session credential. Keychain (not UserDefaults) because it's a bearer credential:
/// device-encrypted, excluded from unencrypted backups, and cleared on `signOut`.
///
/// Written by `AuthManager` after a successful GitHub sign-in captures the cookie from
/// `HTTPCookieStorage.shared`; read by `DashboardStore` at connect time to frame the
/// `Cookie: pi_dash_token=<jwt>` header on the WS upgrade + REST. Decoupling the read
/// from `AuthManager` (both go through this store) keeps the store free of an
/// `AuthManager` reference.
///
/// `kSecAttrAccessibleAfterFirstUnlock` so a background reconnect (the app was launched
/// then backgrounded) can still read the cookie, while it stays unreadable before the
/// first unlock after boot.
enum AuthCookieStore {
    private static let service = "technology.blackbelt.pidashboard.auth"
    private static let account = "pi_dash_token"

    /// Persist (or overwrite) the JWT. A nil/empty value clears the item instead of
    /// storing an empty credential.
    static func save(_ jwt: String?) {
        guard let jwt, !jwt.trimmingCharacters(in: .whitespaces).isEmpty else { clear(); return }
        let data = Data(jwt.utf8)
        // Delete any existing item first so this is a clean upsert (SecItemUpdate needs
        // an existing item + a separate attrs dict; delete+add is simpler and atomic enough).
        SecItemDelete(baseQuery() as CFDictionary)
        var attrs = baseQuery()
        attrs[kSecValueData as String] = data
        attrs[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(attrs as CFDictionary, nil)
    }

    /// The stored JWT, or nil if none (fresh install / signed out).
    static func load() -> String? {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess,
              let data = out as? Data,
              let jwt = String(data: data, encoding: .utf8),
              !jwt.isEmpty
        else { return nil }
        return jwt
    }

    /// Forget the stored credential (sign-out / 401-expiry).
    static func clear() {
        SecItemDelete(baseQuery() as CFDictionary)
    }

    private static func baseQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}
