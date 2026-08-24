import Foundation

/// Probe-only stand-in for the Keychain-backed cookie store. The auth store is NOT
/// what's under test — the reconnect path is — and touching the real login keychain
/// from a CLI would prompt. Returns a syntactically valid, unexpired JWT so the
/// store's cookie gate opens and the real connect path runs.
enum AuthCookieStore {
    nonisolated(unsafe) static var stub: String? = {
        func b64url(_ s: String) -> String {
            Data(s.utf8).base64EncodedString()
                .replacingOccurrences(of: "+", with: "-")
                .replacingOccurrences(of: "/", with: "_")
                .replacingOccurrences(of: "=", with: "")
        }
        let exp = Int(Date().addingTimeInterval(7 * 86400).timeIntervalSince1970)
        return "\(b64url("{\"alg\":\"HS256\",\"typ\":\"JWT\"}")).\(b64url("{\"sub\":\"probe@local\",\"exp\":\(exp)}")).sig"
    }()
    static func save(_ jwt: String?) { stub = jwt }
    static func load() -> String? { stub }
    static func clear() { stub = nil }
}
