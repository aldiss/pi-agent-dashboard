import Foundation
import PiDashboardKit

/// Probe-only stand-in for the Keychain-backed cookie store. The auth store is NOT
/// what's under test — the reconnect path is — and touching the real login keychain
/// from a CLI would prompt. Supplies a syntactically valid, unexpired JWT for the
/// authenticated and migration probe paths.
enum AuthCookieStore {
    private static let probeJWT: String = {
        func b64url(_ s: String) -> String {
            Data(s.utf8).base64EncodedString()
                .replacingOccurrences(of: "+", with: "-")
                .replacingOccurrences(of: "/", with: "_")
                .replacingOccurrences(of: "=", with: "")
        }
        let exp = Int(Date().addingTimeInterval(7 * 86400).timeIntervalSince1970)
        return "\(b64url("{\"alg\":\"HS256\",\"typ\":\"JWT\"}")).\(b64url("{\"sub\":\"probe@local\",\"exp\":\(exp)}")).sig"
    }()
    nonisolated(unsafe) private static var legacyStub: String?
    nonisolated(unsafe) private static var originStubs: [String: String] = [:]

    static var probeHasLegacy: Bool { legacyStub != nil }

    static func prepareLegacyProbe() {
        legacyStub = probeJWT
        originStubs = [:]
    }

    static func prepareProbe(originKeys: [String]) {
        legacyStub = nil
        originStubs = Dictionary(uniqueKeysWithValues: originKeys.map { ($0, probeJWT) })
    }

    static func probeContains(originKey: String) -> Bool {
        originStubs[originKey] != nil
    }

    static func save(_ jwt: String?, for origin: CredentialOrigin) {
        if let jwt {
            originStubs[origin.storageKey] = jwt
        } else {
            originStubs.removeValue(forKey: origin.storageKey)
        }
    }

    static func load(for origin: CredentialOrigin) -> String? {
        originStubs[origin.storageKey]
    }

    static func clear(for origin: CredentialOrigin) {
        originStubs.removeValue(forKey: origin.storageKey)
    }

    static func migrateLegacyIfNeeded(into origin: CredentialOrigin?) {
        guard let legacy = legacyStub else { return }
        if let origin {
            if originStubs[origin.storageKey] == nil {
                originStubs[origin.storageKey] = legacy
            }
        }
        legacyStub = nil
    }
}
