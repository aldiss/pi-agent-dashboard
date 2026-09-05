import XCTest
@testable import PiDashboardKit

/// B10 instrumentation contract.
///
/// The client currently learns almost nothing when a socket dies: `receiveLoop`'s
/// catch records `error.localizedDescription` and an HTTP status, and nothing ever
/// reads `URLSessionWebSocketTask.closeCode` / `.closeReason`. The server half has
/// the mirror-image defect — `ws.on("close", () => {` discards the `(code, reason)`
/// the `ws` library passes (`browser-gateway.ts:1056` on origin/main). So when B10
/// fires, NEITHER end records why, and every investigation so far has had to reason
/// from an absence that is uninformative by construction.
///
/// This classifier is the client mirror of the server's `bridge-disconnect-classifier`
/// (which already declares `closeCode?: number`), so the two ends describe a
/// disconnect in the same vocabulary.
///
/// WHAT IT CAN AND CANNOT PROVE — this bound is load-bearing and must not be
/// over-read later: an RFC 6455 close code can be absent entirely on an abrupt
/// transport drop. So this splits ORDERLY (a peer chose to close, and said so) from
/// ABRUPT (the transport died with no close frame). It does NOT attribute the cause
/// to server vs Cloudflare tunnel vs mobile network. It narrows the space; it does
/// not settle it.
final class SocketCloseClassifierTests: XCTestCase {

    // `URLSessionWebSocketTask.CloseCode.invalid` is rawValue 0 — "no close frame seen".
    private let invalid = 0

    func testNoCloseFrameIsAbrupt() {
        XCTAssertEqual(
            SocketCloseClassifier.classify(closeCodeRawValue: invalid, reason: nil),
            .abrupt,
            "rawValue 0 is .invalid — the transport died without an RFC 6455 close frame")
    }

    func testNormalClosureIsOrderly() {
        XCTAssertEqual(
            SocketCloseClassifier.classify(closeCodeRawValue: 1000, reason: nil),
            .orderly(code: 1000, reason: nil))
    }

    func testOrderlyCarriesADecodedReason() {
        let reason = Data("going away".utf8)
        XCTAssertEqual(
            SocketCloseClassifier.classify(closeCodeRawValue: 1001, reason: reason),
            .orderly(code: 1001, reason: "going away"))
    }

    func testEmptyReasonIsNilNotEmptyString() {
        XCTAssertEqual(
            SocketCloseClassifier.classify(closeCodeRawValue: 1000, reason: Data()),
            .orderly(code: 1000, reason: nil),
            "an empty payload is absence of a reason, not a reason that is blank")
    }

    func testUndecodableReasonDegradesToNilRatherThanFailing() {
        // Lone continuation byte — not valid UTF-8. Must not crash or lose the code.
        let bad = Data([0xFF, 0xFE])
        XCTAssertEqual(
            SocketCloseClassifier.classify(closeCodeRawValue: 1011, reason: bad),
            .orderly(code: 1011, reason: nil),
            "an unreadable reason must never discard the code, which is the useful half")
    }

    func testAbruptIgnoresAnyStrayReasonPayload() {
        XCTAssertEqual(
            SocketCloseClassifier.classify(closeCodeRawValue: invalid, reason: Data("x".utf8)),
            .abrupt,
            "without a close frame there is no reason to report, whatever the buffer holds")
    }

    // MARK: the operator/log-facing summary

    func testSummaryDistinguishesAbruptFromOrderly() {
        let abrupt = SocketCloseClassifier.classify(closeCodeRawValue: invalid, reason: nil)
        let orderly = SocketCloseClassifier.classify(closeCodeRawValue: 1012, reason: nil)
        XCTAssertNotEqual(abrupt.summary, orderly.summary,
                          "the two cases must be tellable apart in a log line")
        XCTAssertTrue(abrupt.summary.lowercased().contains("abrupt"))
        XCTAssertTrue(orderly.summary.contains("1012"),
                      "the code is the evidence — it must survive into the summary")
    }

    func testOrderlySummaryIncludesTheReasonWhenPresent() {
        let orderly = SocketCloseClassifier.classify(
            closeCodeRawValue: 1001, reason: Data("server restarting".utf8))
        XCTAssertTrue(orderly.summary.contains("server restarting"))
    }
}
