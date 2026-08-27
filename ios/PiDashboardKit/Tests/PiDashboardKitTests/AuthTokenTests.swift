import XCTest
@testable import PiDashboardKit

/// Pure-logic coverage for the multi-operator GitHub-OAuth cookie gate — the whole
/// auth CONTRACT the app wires (auth-start URL, cookie header framing, JWT `exp`
/// pre-check, `/auth/status` decode, and the sign-in→cookie CAPTURE spike) is pinned
/// here under `swift test`: zero simulator, zero live OAuth. ASWebAuthenticationSession
/// + Keychain + `HTTPCookieStorage.shared` are the app's device layer and verified by
/// Portico on the sim; everything below is deterministic.
final class AuthTokenTests: XCTestCase {

    private let base = URL(string: "https://dash.deckdeckshare.com")!

    // MARK: Auth-start + status URLs

    func testAuthStartURLNativeLoginShape() {
        let url = AuthToken.authStartURL(base: base)
        XCTAssertEqual(
            url?.absoluteString,
            "https://dash.deckdeckshare.com/auth/login?native=1&redirect_uri=pidashboard://auth-done")
        // The scheme the OAuth redirect lands on is the callback scheme we register.
        XCTAssertEqual(AuthToken.callbackScheme, "pidashboard")
        XCTAssertEqual(AuthToken.callbackURL, "pidashboard://auth-done")
    }

    func testAuthStartURLToleratesTrailingSlash() {
        let url = AuthToken.authStartURL(base: URL(string: "https://dash.deckdeckshare.com/")!)
        XCTAssertEqual(
            url?.absoluteString,
            "https://dash.deckdeckshare.com/auth/login?native=1&redirect_uri=pidashboard://auth-done")
    }

    func testStatusURLShape() {
        XCTAssertEqual(AuthToken.statusURL(base: base)?.absoluteString,
                       "https://dash.deckdeckshare.com/auth/status")
        XCTAssertEqual(AuthToken.statusURL(base: URL(string: "https://dash.deckdeckshare.com/")!)?
                        .absoluteString,
                       "https://dash.deckdeckshare.com/auth/status")
    }

    func testTunnelConstants() {
        XCTAssertEqual(AuthToken.tunnelHost, "dash.deckdeckshare.com")
        XCTAssertEqual(AuthToken.tunnelBaseURL, "https://dash.deckdeckshare.com")
        XCTAssertEqual(AuthToken.cookieName, "pi_dash_token")
    }

    // MARK: Cookie header framing

    func testCookieHeaderValue() {
        XCTAssertEqual(AuthToken.cookieHeaderValue("abc.def.ghi"), "pi_dash_token=abc.def.ghi")
    }

    func testCookieHeaderValueEmptyIsNil() {
        XCTAssertNil(AuthToken.cookieHeaderValue(""))
        XCTAssertNil(AuthToken.cookieHeaderValue("   "))
    }

    // MARK: JWT exp pre-check

    /// Build a JWT-shaped `header.payload.signature` with a real base64url payload so the
    /// decoder is exercised end-to-end (not a hand-waved stub).
    private func makeJWT(exp: TimeInterval?) -> String {
        let header = jsonBase64url(["alg": "HS256", "typ": "JWT"])
        var claims: [String: Any] = [
            "sub": "v.drobkov@gmail.com", "name": "Op", "username": "aldiss", "provider": "github",
            "iat": 1_700_000_000,
        ]
        if let exp { claims["exp"] = exp }
        let payload = jsonBase64url(claims)
        return "\(header).\(payload).c2lnbmF0dXJl" // signature segment is opaque (never verified here)
    }

    private func jsonBase64url(_ obj: [String: Any]) -> String {
        let data = try! JSONSerialization.data(withJSONObject: obj)
        return data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    func testDecodeExpiryRoundTrips() {
        let exp: TimeInterval = 1_800_000_000
        let jwt = makeJWT(exp: exp)
        XCTAssertEqual(AuthToken.decodeExpiry(jwt)?.timeIntervalSince1970 ?? 0, exp, accuracy: 0.5)
    }

    func testDecodeExpiryNilForWrongSegmentCount() {
        XCTAssertNil(AuthToken.decodeExpiry("only.two"))
        XCTAssertNil(AuthToken.decodeExpiry("abcd"))
        XCTAssertNil(AuthToken.decodeExpiry("a.b.c.d"))
    }

    func testDecodeExpiryNilForMissingExp() {
        XCTAssertNil(AuthToken.decodeExpiry(makeJWT(exp: nil)))
    }

    func testIsPlausiblyValidTrueForFutureExp() {
        let future = Date().addingTimeInterval(7 * 24 * 3600)
        XCTAssertTrue(AuthToken.isPlausiblyValid(makeJWT(exp: future.timeIntervalSince1970)))
    }

    func testIsPlausiblyValidFalseForPastExp() {
        let past = Date().addingTimeInterval(-60)
        XCTAssertFalse(AuthToken.isPlausiblyValid(makeJWT(exp: past.timeIntervalSince1970)))
    }

    func testIsPlausiblyValidFalseForWithinSkew() {
        // exp is 10s out but skew is 30s → treated as already done (don't open a doomed WS).
        let soon = Date().addingTimeInterval(10)
        XCTAssertFalse(AuthToken.isPlausiblyValid(makeJWT(exp: soon.timeIntervalSince1970), skew: 30))
    }

    func testIsPlausiblyValidFalseForNilOrEmpty() {
        XCTAssertFalse(AuthToken.isPlausiblyValid(nil))
        XCTAssertFalse(AuthToken.isPlausiblyValid(""))
        XCTAssertFalse(AuthToken.isPlausiblyValid("   "))
    }

    func testIsPlausiblyValidTrueForOpaqueButPresent() {
        // Non-JWT-shaped but non-empty → let the server be the judge (don't self-reject).
        XCTAssertTrue(AuthToken.isPlausiblyValid("opaque-token-no-dots"))
    }

    // MARK: /auth/status decode

    func testAuthStatusDecodeAuthenticated() throws {
        let json = """
        {"authenticated":true,"user":{"name":"Op","email":"v.drobkov@gmail.com","provider":"github"}}
        """.data(using: .utf8)!
        let status = try JSONDecoder().decode(AuthStatus.self, from: json)
        XCTAssertTrue(status.authenticated)
        XCTAssertEqual(status.user?.email, "v.drobkov@gmail.com")
        XCTAssertEqual(status.user?.provider, "github")
    }

    func testAuthStatusDecodeUnauthenticated() throws {
        let json = #"{"authenticated":false,"user":null}"#.data(using: .utf8)!
        let status = try JSONDecoder().decode(AuthStatus.self, from: json)
        XCTAssertFalse(status.authenticated)
        XCTAssertNil(status.user)
    }

    // MARK: domain-match rule

    func testDomainMatchesExactHost() {
        XCTAssertTrue(AuthToken.domainMatches(cookieDomain: "dash.deckdeckshare.com", host: "dash.deckdeckshare.com"))
    }

    func testDomainMatchesDotPrefixedParent() {
        XCTAssertTrue(AuthToken.domainMatches(cookieDomain: ".deckdeckshare.com", host: "dash.deckdeckshare.com"))
    }

    func testDomainMatchesBareParent() {
        XCTAssertTrue(AuthToken.domainMatches(cookieDomain: "deckdeckshare.com", host: "dash.deckdeckshare.com"))
    }

    func testDomainMatchesRejectsLookalikeSuffix() {
        XCTAssertFalse(AuthToken.domainMatches(cookieDomain: "deckdeckshare.com.evil.com", host: "dash.deckdeckshare.com"))
    }

    func testDomainMatchesRejectsUnrelatedHost() {
        XCTAssertFalse(AuthToken.domainMatches(cookieDomain: "other.com", host: "dash.deckdeckshare.com"))
    }

    func testDomainMatchesIgnoresCase() {
        XCTAssertTrue(AuthToken.domainMatches(cookieDomain: ".DeckDeckShare.COM", host: "DASH.deckdeckshare.com"))
    }

    // MARK: Native token exchange (single-use code → JWT in the response body)

    func testExtractExchangeCodePresent() {
        let url = URL(string: "pidashboard://auth-done?code=abc123")!
        XCTAssertEqual(AuthToken.extractExchangeCode(from: url), "abc123")
    }

    func testExtractExchangeCodeMissing() {
        let url = URL(string: "pidashboard://auth-done")!
        XCTAssertNil(AuthToken.extractExchangeCode(from: url))
    }

    func testExtractExchangeCodeEmptyIsNil() {
        let url = URL(string: "pidashboard://auth-done?code=")!
        XCTAssertNil(AuthToken.extractExchangeCode(from: url))
    }

    func testExtractExchangeCodeIgnoresOtherParams() {
        let url = URL(string: "pidashboard://auth-done?state=x&code=tok-9&foo=bar")!
        XCTAssertEqual(AuthToken.extractExchangeCode(from: url), "tok-9")
    }

    func testExtractExchangeCodeRejectsWrongHost() {
        // Defense-in-depth: a callback whose host isn't `auth-done` is rejected even if it
        // carries a code (the ASWeb scheme binding doesn't constrain the host).
        let url = URL(string: "pidashboard://evil?code=abc")!
        XCTAssertNil(AuthToken.extractExchangeCode(from: url))
    }

    func testExtractExchangeCodeRejectsWrongScheme() {
        let url = URL(string: "https://auth-done?code=abc")!
        XCTAssertNil(AuthToken.extractExchangeCode(from: url))
    }

    func testExtractExchangeCodeRejectsOverlongCode() {
        let long = String(repeating: "a", count: 513)
        let url = URL(string: "pidashboard://auth-done?code=\(long)")!
        XCTAssertNil(AuthToken.extractExchangeCode(from: url))
    }

    func testExchangeURLAppendsPath() {
        let base = URL(string: "https://dash.deckdeckshare.com")!
        XCTAssertEqual(AuthToken.exchangeURL(base: base)?.absoluteString,
                       "https://dash.deckdeckshare.com/api/auth/exchange")
    }

    func testExchangeURLToleratesTrailingSlash() {
        let base = URL(string: "https://dash.deckdeckshare.com/")!
        XCTAssertEqual(AuthToken.exchangeURL(base: base)?.absoluteString,
                       "https://dash.deckdeckshare.com/api/auth/exchange")
    }

    func testExchangeRequestBodyEncodesCode() throws {
        let body = try AuthToken.exchangeRequestBody(code: "c-42")
        let obj = try JSONDecoder().decode([String: String].self, from: body)
        XCTAssertEqual(obj, ["code": "c-42"])
    }

    func testExchangeResponseDecodesToken() throws {
        let json = Data(#"{"token":"jwt-xyz"}"#.utf8)
        let decoded = try JSONDecoder().decode(AuthToken.ExchangeResponse.self, from: json)
        XCTAssertEqual(decoded.token, "jwt-xyz")
    }
}
