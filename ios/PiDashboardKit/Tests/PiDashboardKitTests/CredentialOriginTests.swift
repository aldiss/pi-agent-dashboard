import Foundation
import XCTest
@testable import PiDashboardKit

final class CredentialOriginTests: XCTestCase {
    func testDefaultPortsCanonicalize() throws {
        let implicitHTTPS = try XCTUnwrap(CredentialOrigin(url: URL(string: "https://h")!))
        let explicitHTTPS = try XCTUnwrap(CredentialOrigin(url: URL(string: "https://h:443")!))
        let implicitHTTP = try XCTUnwrap(CredentialOrigin(url: URL(string: "http://h")!))
        let explicitHTTP = try XCTUnwrap(CredentialOrigin(url: URL(string: "http://h:80")!))

        XCTAssertEqual(implicitHTTPS, explicitHTTPS)
        XCTAssertEqual(implicitHTTP, explicitHTTP)
        XCTAssertEqual(implicitHTTPS.storageKey, "https://h:443")
        XCTAssertEqual(implicitHTTP.storageKey, "http://h:80")
    }

    func testCaseAndTrailingDotCanonicalize() throws {
        let mixed = try XCTUnwrap(CredentialOrigin(url: URL(string: "https://Dash.Example.com./")!))
        let canonical = try XCTUnwrap(CredentialOrigin(url: URL(string: "https://dash.example.com:443")!))

        XCTAssertEqual(mixed, canonical)
        XCTAssertEqual(mixed.storageKey, "https://dash.example.com:443")
    }

    func testDistinctPortsAreDistinctOrigins() throws {
        let first = try XCTUnwrap(CredentialOrigin(url: URL(string: "https://host.example:8000")!))
        let second = try XCTUnwrap(CredentialOrigin(url: URL(string: "https://host.example:8001")!))

        XCTAssertNotEqual(first, second)
    }

    func testSchemeDistinguishesOrigin() throws {
        let http = try XCTUnwrap(CredentialOrigin(url: URL(string: "http://h:80")!))
        let https = try XCTUnwrap(CredentialOrigin(url: URL(string: "https://h:443")!))

        XCTAssertNotEqual(http, https)
    }

    func testLoopbackDetection() throws {
        let loopbackURLs = ["http://127.0.0.1", "http://127.42.7.9", "http://[::1]", "http://localhost"]
        let remoteURLs = ["http://10.0.0.5", "https://example.com"]

        for raw in loopbackURLs {
            let origin = try XCTUnwrap(CredentialOrigin(url: URL(string: raw)!))
            XCTAssertTrue(origin.isLoopback, raw)
        }
        for raw in remoteURLs {
            let origin = try XCTUnwrap(CredentialOrigin(url: URL(string: raw)!))
            XCTAssertFalse(origin.isLoopback, raw)
        }
    }

    func testNonHTTPSchemeRejected() {
        XCTAssertNil(CredentialOrigin(url: URL(string: "pidashboard://auth-done")!))
    }
}
