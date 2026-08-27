import Foundation
import Security
import PiDashboardKit

/// Keychain-backed store for the `pi_dash_token` JWT cookie — the operator's dashboard
/// session credential. Keychain (not UserDefaults) because it's a bearer credential:
/// device-encrypted, excluded from unencrypted backups, and cleared on `signOut`.
///
/// Written by `AuthManager` after successful GitHub sign-in; read by `DashboardStore`
/// at connect time to frame the cookie header on WS + REST requests. Accounts use the
/// normalized issuing origin, so one dashboard's bearer cannot be loaded for another.
///
/// `kSecAttrAccessibleAfterFirstUnlock` so a background reconnect (the app was launched
/// then backgrounded) can still read the cookie, while it stays unreadable before the
/// first unlock after boot.
enum AuthCookieStore {
    private static let service = "technology.blackbelt.pidashboard.auth"
    private static let legacyAccount = "pi_dash_token"

    /// Persist (or overwrite) the JWT. A nil/empty value clears the item instead of
    /// storing an empty credential.
    static func save(_ jwt: String?, for origin: CredentialOrigin) {
        guard let jwt, !jwt.trimmingCharacters(in: .whitespaces).isEmpty else {
            clear(for: origin)
            return
        }
        _ = write(jwt, account: origin.storageKey)
    }

    /// The stored JWT, or nil if none (fresh install / signed out).
    static func load(for origin: CredentialOrigin) -> String? {
        load(account: origin.storageKey)
    }

    /// Forget one origin's credential (sign-out / auth rejection).
    static func clear(for origin: CredentialOrigin) {
        SecItemDelete(baseQuery(account: origin.storageKey) as CFDictionary)
    }

    /// One-way migration from the build-8 global account. A legacy bearer is moved only
    /// when its issuing origin can be recovered from the stored server preference. The
    /// source item is retained if the destination write fails; unattributable bearers are
    /// deleted instead of being guessed onto a future origin.
    static func migrateLegacyIfNeeded(into origin: CredentialOrigin?) {
        guard let jwt = load(account: legacyAccount) else { return }
        guard let origin else {
            SecItemDelete(baseQuery(account: legacyAccount) as CFDictionary)
            return
        }

        if load(for: origin) != nil || write(jwt, account: origin.storageKey) {
            SecItemDelete(baseQuery(account: legacyAccount) as CFDictionary)
        }
    }

    private static func load(account: String) -> String? {
        var query = baseQuery(account: account)
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

    @discardableResult
    private static func write(_ jwt: String, account: String) -> Bool {
        let query = baseQuery(account: account)
        let values: [String: Any] = [
            kSecValueData as String: Data(jwt.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]
        let update = SecItemUpdate(query as CFDictionary, values as CFDictionary)
        if update == errSecSuccess { return true }
        guard update == errSecItemNotFound else { return false }

        var attrs = query
        values.forEach { attrs[$0.key] = $0.value }
        return SecItemAdd(attrs as CFDictionary, nil) == errSecSuccess
    }

    private static func baseQuery(account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}
