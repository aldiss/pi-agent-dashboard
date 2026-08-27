import Foundation

/// UI-free contract for the dashboard's **multi-operator GitHub-OAuth cookie gate** —
/// the exact auth surface `packages/server/src/auth-plugin.ts` enforces. The device-only
/// pieces (ASWebAuthenticationSession, Keychain, `HTTPCookieStorage.shared`) live in the
/// app's `AuthManager`; everything pin-able without a simulator — the auth-start URL,
/// the `pi_dash_token` cookie name + header framing, the JWT `exp` pre-check, the
/// `/auth/status` decode, and the cookie-capture rule — lives here and is covered by
/// `swift test`.
///
/// Auth contract (verified own-hand on dashboard `feat/multi-operator-2026-07-08`):
/// - The live **WebSocket** upgrade is **cookie-only** — no loopback / trusted-net /
///   Bearer bypass. It requires a valid `pi_dash_token` JWT cookie or it 401s.
/// - The cookie is obtained by **browser OAuth only**: `GET /auth/start/github?return=…`
///   → GitHub → `/auth/callback/github` sets `pi_dash_token` (httpOnly, sameSite=lax,
///   secure-on-https, maxAge=7d), then redirects to `returnUrl`.
/// - `pi_dash_token` = HS256 JWT `{ sub:<email>, name, username, provider:"github",
///   iat, exp = iat+7d }`. The signature is server-verified; the app only pre-checks
///   `exp` client-side to skip a doomed round-trip (a hint, NOT a security gate).
/// - The cookie is **domain-bound to the tunnel host** — a raw Tailscale-IP origin
///   won't carry it, so the connect target MUST be `https://dash.deckdeckshare.com`.
public enum AuthToken {

    // MARK: Contract constants

    /// The JWT cookie the multi-operator gate requires on the WS upgrade + REST.
    public static let cookieName = "pi_dash_token"

    /// The tunnel host the cookie is domain-bound to. The app defaults its connect
    /// target here — a raw IP origin can't carry the cookie, so the WS would 401.
    public static let tunnelHost = "dash.deckdeckshare.com"

    /// The tunnel base URL (https — the cookie is `secure`, so http would drop it).
    public static let tunnelBaseURL = "https://\(tunnelHost)"

    /// The custom URL scheme ASWebAuthenticationSession watches for the OAuth callback.
    /// Registered in `Info.plist` (`CFBundleURLSchemes`) so the final redirect resolves.
    public static let callbackScheme = "pidashboard"

    /// The callback URL host component (`pidashboard://auth-done` → "auth-done").
    /// Validated explicitly in `extractExchangeCode` as defense-in-depth — the ASWeb scheme
    /// binding guarantees the scheme but NOT the host.
    public static let callbackHost = "auth-done"

    /// The full callback URL passed as `?return=` — the OAuth's final redirect hits this,
    /// and the scheme match fires the session's completion handler.
    public static let callbackURL = "\(callbackScheme)://\(callbackHost)"

    // MARK: Auth-start URL

    /// `GET <base>/auth/login?native=1&redirect_uri=<callback>` — the v4 NATIVE-flow
    /// browser-OAuth entry the app opens in ASWebAuthenticationSession. The `native=1` +
    /// `redirect_uri` signal the native flow, so the server validates the redirect (A6
    /// exact), produces the SIGNED-native HMAC (1-dot) `state` envelope, and issues the
    /// single-use `?code=` on the callback. The unsigned `/auth/start/:provider?return=`
    /// browser path produces a 0-dot state and does NOT reach the native code branch in v4
    /// — so the native app MUST use this entry. `/auth/login` auto-redirects to the single
    /// configured provider (github). Values encode via `URLComponents`; `redirect_uri` is
    /// validated server-side as EXACTLY `pidashboard://auth-done` (A6). Tolerant of a
    /// trailing slash on `base`.
    public static func authStartURL(base: URL, redirectURI: String = callbackURL) -> URL? {
        var trimmed = base.absoluteString
        while trimmed.hasSuffix("/") { trimmed.removeLast() }
        guard var comps = URLComponents(string: "\(trimmed)/auth/login") else { return nil }
        comps.queryItems = [
            URLQueryItem(name: "native", value: "1"),
            URLQueryItem(name: "redirect_uri", value: redirectURI),
        ]
        return comps.url
    }

    /// `<base>/auth/status` — the no-auth login-state probe.
    public static func statusURL(base: URL) -> URL? {
        var trimmed = base.absoluteString
        while trimmed.hasSuffix("/") { trimmed.removeLast() }
        return URL(string: "\(trimmed)/auth/status")
    }

    // MARK: Native token exchange (single-use code → JWT in the response body)

    /// `POST <base>/api/auth/exchange` — the native-flow token endpoint. iOS
    /// ASWebAuthenticationSession does NOT propagate the server's `Set-Cookie` to
    /// `HTTPCookieStorage.shared` (empirically confirmed on-device), so instead the server
    /// hands back a single-use short-TTL `code` on the callback and the app trades it here
    /// for the `pi_dash_token` JWT in the RESPONSE BODY — the JWT never transits a URL.
    /// Tolerant of a trailing slash on `base`.
    public static func exchangeURL(base: URL) -> URL? {
        var trimmed = base.absoluteString
        while trimmed.hasSuffix("/") { trimmed.removeLast() }
        return URL(string: "\(trimmed)/api/auth/exchange")
    }

    /// The single-use `?code=` from the ASWeb completion-handler callback URL
    /// (`pidashboard://auth-done?code=<code>`). MUST be read ONLY from the ASWeb
    /// callbackURL (session-bound → hijack-resistant, A11) — never a general `onOpenURL` /
    /// `application(_:open:)` handler. Defense-in-depth (architect build-note): validates
    /// scheme + host + code shape (non-empty, bounded length, no whitespace) before
    /// trusting the code. nil when anything fails.
    public static func extractExchangeCode(from callbackURL: URL) -> String? {
        guard callbackURL.scheme == callbackScheme,
              callbackURL.host == callbackHost,
              let comps = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false),
              let raw = comps.queryItems?.first(where: { $0.name == "code" })?.value else { return nil }
        let code = raw.trimmingCharacters(in: .whitespaces)
        // Code-shape sanity: non-empty, bounded (a 256-bit code is ~43-64 chars), no
        // whitespace/control chars. Lenient on exact charset — the server owns the encoding.
        guard !code.isEmpty, code.count <= 512,
              code.rangeOfCharacter(from: .whitespacesAndNewlines) == nil else { return nil }
        return code
    }

    /// The JSON body the app POSTs to `/api/auth/exchange`: `{"code":"<code>"}`
    /// (Content-Type: application/json; unauthenticated — the code IS the credential).
    public static func exchangeRequestBody(code: String) throws -> Data {
        try JSONEncoder().encode(["code": code])
    }

    /// The success (200) `/api/auth/exchange` response body: `{"token":"<pi_dash_token JWT>"}`.
    /// (Failure is a non-200 — e.g. 400 `{"error":"invalid_or_expired_code"}` — handled by
    /// the caller on status, not decoded here.)
    public struct ExchangeResponse: Decodable, Sendable, Equatable {
        public let token: String
        public init(token: String) { self.token = token }
    }

    // MARK: Cookie header framing

    /// The `Cookie` request-header value carrying the JWT: `pi_dash_token=<jwt>`. This is
    /// what the app sets on the WS upgrade AND REST requests (replacing the rejected
    /// `Authorization: Bearer` header). Returns nil for an empty token so callers omit
    /// the header entirely rather than sending `pi_dash_token=`.
    public static func cookieHeaderValue(_ jwt: String) -> String? {
        let v = jwt.trimmingCharacters(in: .whitespaces)
        return v.isEmpty ? nil : "\(cookieName)=\(v)"
    }

    // MARK: JWT exp pre-check (a hint, not a security gate)

    /// Decode a JWT's `exp` (seconds since epoch) from its middle (payload) segment,
    /// base64url-decoded. The signature is NOT verified here — the server does that; this
    /// only reads `exp` to skip a connect we already know is expired. Returns nil for a
    /// malformed token (wrong segment count, bad base64url, no numeric `exp`).
    public static func decodeExpiry(_ jwt: String) -> Date? {
        let segments = jwt.split(separator: ".", omittingEmptySubsequences: false)
        guard segments.count == 3 else { return nil }
        guard let payload = base64urlDecode(String(segments[1])) else { return nil }
        guard let obj = try? JSONDecoder().decode(ExpiryClaim.self, from: payload),
              let exp = obj.exp else { return nil }
        return Date(timeIntervalSince1970: exp)
    }

    /// Client-side plausibility of a stored JWT: present + parseable + not past `exp`
    /// (minus a small skew so a token expiring in the next few seconds counts as done).
    /// A saves-a-round-trip hint before we open the WS — NEVER the security decision
    /// (the server re-verifies the signature + expiry). A token with no decodable `exp`
    /// is treated as plausible (let the server be the judge) as long as it's non-empty.
    public static func isPlausiblyValid(_ jwt: String?, now: Date = Date(),
                                        skew: TimeInterval = 30) -> Bool {
        guard let jwt, !jwt.trimmingCharacters(in: .whitespaces).isEmpty else { return false }
        guard let exp = decodeExpiry(jwt) else { return true } // opaque but present → let server judge
        return exp.timeIntervalSince(now) > skew
    }

    private struct ExpiryClaim: Decodable {
        let exp: TimeInterval?
    }

    /// Base64url → Data (JWT dialect: `-`→`+`, `_`→`/`, no `=` padding). Pads to a
    /// multiple of 4 before decoding. nil on invalid input.
    static func base64urlDecode(_ s: String) -> Data? {
        var b64 = s.replacingOccurrences(of: "-", with: "+")
                   .replacingOccurrences(of: "_", with: "/")
        let remainder = b64.count % 4
        if remainder > 0 { b64 += String(repeating: "=", count: 4 - remainder) }
        return Data(base64Encoded: b64)
    }

    /// RFC 6265 domain match, narrowed to what we need: exact host, or the cookie domain
    /// is a dot-prefixed suffix of the host (`.deckdeckshare.com` ⊇ `dash.deckdeckshare.com`).
    /// Public so the app's `AuthManager.signOut()` can scope the shared-jar cookie sweep.
    public static func domainMatches(cookieDomain: String, host: String) -> Bool {
        let d = cookieDomain.lowercased()
        let h = host.lowercased()
        if d == h { return true }
        let bare = d.hasPrefix(".") ? String(d.dropFirst()) : d
        if bare == h { return true }
        return h.hasSuffix("." + bare)
    }
}

/// The `/auth/status` (no-auth) response — drives the app's signed-in banner
/// (name/email/provider) without decoding the JWT. `user` is null when unauthenticated.
public struct AuthStatus: Decodable, Sendable, Equatable {
    public let authenticated: Bool
    public let user: AuthUser?

    public init(authenticated: Bool, user: AuthUser?) {
        self.authenticated = authenticated
        self.user = user
    }
}

/// The operator identity the server derives from the GitHub login (the app sends nothing
/// identity-specific — just the cookie; the server maps it to one of the operator seats).
public struct AuthUser: Decodable, Sendable, Equatable {
    public let name: String?
    public let email: String?
    public let provider: String?

    public init(name: String?, email: String?, provider: String?) {
        self.name = name
        self.email = email
        self.provider = provider
    }
}
