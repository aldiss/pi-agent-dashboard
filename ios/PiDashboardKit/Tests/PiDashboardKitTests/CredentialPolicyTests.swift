import Foundation
import XCTest
@testable import PiDashboardKit

final class CredentialPolicyTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func origin(_ raw: String) -> CredentialOrigin {
        CredentialOrigin(url: URL(string: raw)!)!
    }

    private func jwt(exp: TimeInterval) -> String {
        let payload = try! JSONSerialization.data(withJSONObject: ["exp": exp])
            .base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        return "header.\(payload).signature"
    }

    func testSameOriginHTTPSAttaches() {
        let target = origin("https://dash.example.com")
        let token = jwt(exp: now.timeIntervalSince1970 + 3_600)

        XCTAssertEqual(
            CredentialPolicy.decide(target: target, stored: (target, token), now: now),
            .attach(token)
        )
    }

    func testForeignOriginOmits() {
        let target = origin("https://b.example.com")
        let stored = origin("https://a.example.com")

        XCTAssertEqual(
            CredentialPolicy.decide(target: target, stored: (stored, "opaque-token"), now: now),
            .omit(.foreignOrigin)
        )
    }

    func testPlaintextNonLoopbackOmits() {
        let target = origin("http://10.0.0.5")

        XCTAssertEqual(
            CredentialPolicy.decide(target: target, stored: (target, "opaque-token"), now: now),
            .omit(.insecureTransport)
        )
    }

    func testPlaintextLoopbackAttaches() {
        let target = origin("http://127.0.0.1:9998")

        XCTAssertEqual(
            CredentialPolicy.decide(target: target, stored: (target, "opaque-token"), now: now),
            .attach("opaque-token")
        )
    }

    func testNoStoredCredentialOmitsNotBlocks() {
        let target = origin("https://new.example.com")

        XCTAssertEqual(
            CredentialPolicy.decide(target: target, stored: nil, now: now),
            .omit(.none)
        )
    }

    func testExpiredCredentialOmits() {
        let target = origin("https://dash.example.com")

        XCTAssertEqual(
            CredentialPolicy.decide(
                target: target,
                stored: (target, jwt(exp: now.timeIntervalSince1970 - 1)),
                now: now
            ),
            .omit(.expired)
        )
    }

    func testPortMismatchOmits() {
        let target = origin("https://host.example:8001")
        let stored = origin("https://host.example:8000")

        XCTAssertEqual(
            CredentialPolicy.decide(target: target, stored: (stored, "opaque-token"), now: now),
            .omit(.foreignOrigin)
        )
    }

    func testSessionConfigDoesNotUseSharedCookieJar() {
        let configuration = DashboardSessionConfiguration.make()

        XCTAssertFalse(configuration.httpShouldSetCookies)
        XCTAssertNil(configuration.httpCookieStorage)
    }
}
