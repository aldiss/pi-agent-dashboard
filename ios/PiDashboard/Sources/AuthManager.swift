import Foundation
import Observation
import AuthenticationServices
import UIKit
import PiDashboardKit

/// App-layer auth orchestrator for the dashboard's **multi-operator GitHub-OAuth cookie
/// gate**. SwiftUI/`ASWebAuthenticationSession`/Keychain are app concerns (not the
/// UI-free Kit), so this lives in the app target; the pure contract (auth-start URL,
/// cookie name/framing, JWT `exp` pre-check, `/auth/status` decode, cookie-capture rule)
/// is `AuthToken` in the Kit and is `swift test`-covered.
///
/// Sign-in flow (native token-in-callback exchange). iOS ASWebAuthenticationSession did
/// NOT propagate the server's `Set-Cookie` to `HTTPCookieStorage.shared` on real hardware
/// (empirically confirmed — a successful sign-in but an empty cookie jar), so the cookie-
/// capture path was replaced by a one-time exchange-code:
/// 1. `signIn()` opens `ASWebAuthenticationSession` at
///    `https://dash.deckdeckshare.com/auth/start/github?return=pidashboard://auth-done`
///    with `callbackURLScheme: "pidashboard"`. The OAuth's final redirect fires the
///    completion handler with `pidashboard://auth-done?code=<single-use code>`.
/// 2. The `code` is read ONLY from the ASWeb completion-handler callbackURL (session-bound
///    → hijack-resistant; there is deliberately NO general `onOpenURL` / `application(_:open:)`
///    handler registered for the scheme — see A11).
/// 3. The app POSTs the code to `/api/auth/exchange`; the server burns it (single-use,
///    ~60s TTL) and returns the `pi_dash_token` JWT in the RESPONSE BODY (never in a URL).
///    The JWT is persisted to the Keychain (`AuthCookieStore`) and framed as
///    `Cookie: pi_dash_token=<jwt>` on the WS upgrade + REST — the server's cookie gate is
///    unchanged; the app manufactures the cookie header from the exchanged token.
///
/// ⚠ Failure modes surface honestly (never faked): no `?code=` on the callback →
/// `AuthError.codeNotReturned`; a non-200 from the exchange (e.g. 400 `invalid_or_expired_code`
/// for a burned/expired code) → `AuthError.exchangeFailed`. Do NOT paper over either.
@MainActor
@Observable
final class AuthManager: NSObject {
    enum AuthError: LocalizedError {
        case badURL
        case cancelled
        case codeNotReturned
        case exchangeFailed(Int)
        case session(String)

        var errorDescription: String? {
            switch self {
            case .badURL: return "Couldn't build the sign-in URL."
            case .cancelled: return "Sign-in was cancelled."
            case .codeNotReturned:
                return "Signed in, but the server didn't return an auth code. Tap Sign in to retry."
            case .exchangeFailed(let status):
                return "Signed in, but the token exchange failed (\(status)). Tap Sign in to retry."
            case .session(let m): return m
            }
        }
    }

    /// The dashboard host the auth flow targets (sign-in + exchange + status). Defaults to
    /// the tunnel but FOLLOWS the connect target via `setServer(_:)` — so a non-tunnel base
    /// (e.g. a canary on a Tailscale IP:port) routes the ASWeb /auth/login + /api/auth/exchange
    /// there too. v4-safe: the JWT arrives via the exchange body, not a domain-bound cookie.
    private(set) var host: String
    private(set) var base: URL

    /// The signed-in operator identity from `/auth/status` (name/email/provider), or nil
    /// when signed out. Drives the ConnectView signed-in banner.
    private(set) var user: AuthUser?
    /// In-flight sign-in (drives the button spinner).
    private(set) var isSigningIn = false
    /// Last surfaced auth error (nil once cleared / on a fresh attempt).
    private(set) var lastError: String?

    private var webAuthSession: ASWebAuthenticationSession?

    init(host: String = AuthToken.tunnelHost) {
        self.host = host
        self.base = URL(string: "https://\(host)")!
        super.init()
    }

    /// Point the auth flow at `serverURL` — the server the app is connecting to
    /// (DashboardStore.serverURLString). Keeps the auth base in sync with the connect target
    /// so sign-in (/auth/login), the code exchange (/api/auth/exchange), and /auth/status all
    /// hit the SAME server as the WS/REST — not the hardcoded tunnel. Accepts http/https +
    /// host:port (a canary on a Tailscale IP:port). Invalid/empty → keeps the current base.
    /// v4-safe: the JWT comes from the exchange response body, not a domain-bound cookie.
    func setServer(_ serverURL: String) {
        let trimmed = serverURL.trimmingCharacters(in: .whitespaces)
        guard let url = URL(string: trimmed), let h = url.host else { return }
        self.base = url
        self.host = h
    }

    // MARK: Login state

    /// The stored `pi_dash_token` JWT (Keychain), or nil.
    var sessionCookieValue: String? { AuthCookieStore.load() }

    /// Client-side login hint: a stored cookie whose `exp` (if decodable) is still in the
    /// future. A saves-a-round-trip check — NOT the security gate (the server re-verifies
    /// the signature + expiry on every WS/REST call).
    var isLoggedIn: Bool { AuthToken.isPlausiblyValid(sessionCookieValue) }

    // MARK: Sign in

    /// Run the GitHub-OAuth sign-in. On success the single-use code from the ASWeb callback
    /// is exchanged at `/api/auth/exchange` for the `pi_dash_token` JWT, persisted to the
    /// Keychain, and `/auth/status` refreshes `user`. Throws on cancel, a bad URL, a missing
    /// `?code=`, or a failed exchange.
    func signIn() async throws {
        guard let startURL = AuthToken.authStartURL(base: base) else { throw AuthError.badURL }
        isSigningIn = true
        lastError = nil
        defer { isSigningIn = false }

        // ASWeb → `pidashboard://auth-done?code=<single-use code>`. The code is read ONLY
        // from the completion-handler callbackURL (session-bound → hijack-resistant, A11) —
        // never a general onOpenURL/application(_:open:) handler (none is registered).
        let callbackURL = try await runWebAuth(url: startURL)
        guard let code = AuthToken.extractExchangeCode(from: callbackURL) else {
            lastError = AuthError.codeNotReturned.errorDescription
            throw AuthError.codeNotReturned
        }

        // Trade the single-use code for the pi_dash_token JWT (server burns the code +
        // returns the JWT in the response body — never in a URL), then persist to Keychain.
        let jwt = try await exchangeCode(code)
        AuthCookieStore.save(jwt)
        await refreshStatus()
    }

    /// POST the single-use `code` to `/api/auth/exchange` and return the `pi_dash_token`
    /// JWT from the 200 response body (`{"token":"<jwt>"}`). Throws `.exchangeFailed` on a
    /// non-200 (e.g. 400 `invalid_or_expired_code` for a burned/expired code) or an empty
    /// token, `.session` on transport failure.
    private func exchangeCode(_ code: String) async throws -> String {
        guard let url = AuthToken.exchangeURL(base: base) else { throw AuthError.badURL }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try AuthToken.exchangeRequestBody(code: code)
        req.timeoutInterval = 15

        let data: Data, resp: URLResponse
        do {
            (data, resp) = try await URLSession.shared.data(for: req)
        } catch {
            throw AuthError.session(error.localizedDescription)
        }
        guard let http = resp as? HTTPURLResponse else {
            throw AuthError.session("No HTTP response from the token exchange.")
        }
        guard http.statusCode == 200,
              let decoded = try? JSONDecoder().decode(AuthToken.ExchangeResponse.self, from: data) else {
            throw AuthError.exchangeFailed(http.statusCode)
        }
        let jwt = decoded.token.trimmingCharacters(in: .whitespaces)
        guard !jwt.isEmpty else { throw AuthError.exchangeFailed(http.statusCode) }
        return jwt
    }

    /// Bridge the delegate-style `ASWebAuthenticationSession` to async. Non-ephemeral by
    /// omission — see the type doc: ephemeral would discard the cookie. Maps user-cancel
    /// to `.cancelled`, other failures to `.session`.
    private func runWebAuth(url: URL) async throws -> URL {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<URL, Error>) in
            let session = ASWebAuthenticationSession(
                url: url, callbackURLScheme: AuthToken.callbackScheme) { callbackURL, error in
                if let error {
                    let nsErr = error as NSError
                    if nsErr.domain == ASWebAuthenticationSessionError.errorDomain,
                       nsErr.code == ASWebAuthenticationSessionError.canceledLogin.rawValue {
                        cont.resume(throwing: AuthError.cancelled)
                    } else {
                        cont.resume(throwing: AuthError.session(error.localizedDescription))
                    }
                    return
                }
                guard let callbackURL else {
                    cont.resume(throwing: AuthError.session("No callback URL returned."))
                    return
                }
                cont.resume(returning: callbackURL)
            }
            session.presentationContextProvider = self
            // ⚠ Do NOT set `session.prefersEphemeralWebBrowserSession = true` — ephemeral
            // isolates + discards the cookie, so the WS would 401 despite a "success".
            // The default (non-ephemeral) lands `pi_dash_token` in the shared jar.
            self.webAuthSession = session
            if !session.start() {
                cont.resume(throwing: AuthError.session("Couldn't start the sign-in session."))
            }
        }
    }

    // MARK: Status + sign out

    /// Refresh `user` from `GET /auth/status` (no-auth, but we send the cookie so the
    /// server can identify the operator). Best-effort — a failure leaves `user` unchanged.
    func refreshStatus() async {
        guard let url = AuthToken.statusURL(base: base) else { return }
        var req = URLRequest(url: url)
        if let cookie = sessionCookieValue, let header = AuthToken.cookieHeaderValue(cookie) {
            req.setValue(header, forHTTPHeaderField: "Cookie")
        }
        req.timeoutInterval = 10
        guard let (data, _) = try? await URLSession.shared.data(for: req),
              let status = try? JSONDecoder().decode(AuthStatus.self, from: data)
        else { return }
        user = status.authenticated ? status.user : nil
    }

    /// Sign out: clear the Keychain cookie + the shared cookie jar entry + `user`.
    func signOut() {
        AuthCookieStore.clear()
        if let cookies = HTTPCookieStorage.shared.cookies {
            for c in cookies where c.name == AuthToken.cookieName
                && AuthToken.domainMatches(cookieDomain: c.domain, host: host) {
                HTTPCookieStorage.shared.deleteCookie(c)
            }
        }
        user = nil
        lastError = nil
    }

    /// Clear stored auth after a 401 so the app re-prompts sign-in (cookie expired /
    /// rejected). Keeps `user` display until the next status refresh.
    func handleUnauthorized() {
        AuthCookieStore.clear()
    }
}

/// Present the auth sheet over the app's active key window.
extension AuthManager: ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let window = scenes.flatMap(\.windows).first(where: \.isKeyWindow)
            ?? scenes.first?.windows.first
        return window ?? ASPresentationAnchor()
    }
}
