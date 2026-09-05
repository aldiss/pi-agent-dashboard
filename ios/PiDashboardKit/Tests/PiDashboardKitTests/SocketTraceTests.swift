import XCTest
@testable import PiDashboardKit

/// B10 lifecycle-trace contract.
///
/// Today's instrumentation cannot settle B10 because it is blind exactly where the
/// answer probably is. `lastClose` is not reset on connect, a LOCAL teardown never
/// populates it, and a superseded receive loop returns at
/// `guard socket === task else { return }` BEFORE recording anything — so if the flap
/// is self-inflicted supersession, the instrument sees nothing and we would read that
/// silence as "no local cause". Two of today's wrong conclusions came from exactly
/// that shape: a signal that looks identical whether the hypothesis is true or false.
///
/// These tests pin the properties that make ONE captured flap decisive:
/// per-socket identity, the caller that opened it, the supersession record that the
/// identity guard would otherwise suppress, and a failure record carrying the real
/// error rather than a localized string.
final class SocketTraceTests: XCTestCase {

    private func ev(_ at: Double, _ id: String, _ k: SocketTraceEvent.Kind) -> SocketTraceEvent {
        SocketTraceEvent(at: at, socketID: id, kind: k)
    }

    // MARK: identity — the trace is useless if two sockets blur together

    func testEventsAreAttributableToTheirOwnSocket() {
        var t = SocketTrace(capacity: 16)
        t.record(ev(1, "S1", .connectRequested(origin: .scheduledReconnect)))
        t.record(ev(2, "S2", .connectRequested(origin: .foregroundRecovery)))
        t.record(ev(3, "S1", .streamFinished))
        XCTAssertEqual(t.events(for: "S1").count, 2)
        XCTAssertEqual(t.events(for: "S2").count, 1)
    }

    func testOriginIsPreservedSoWeKnowWhichCallerOpenedTheSocket() {
        var t = SocketTrace(capacity: 8)
        t.record(ev(1, "S1", .connectRequested(origin: .foregroundRecovery)))
        guard case .connectRequested(let origin) = t.events(for: "S1").first?.kind else {
            return XCTFail("origin lost")
        }
        XCTAssertEqual(origin, .foregroundRecovery,
                       "which path opened the socket is the whole supersession question")
    }

    // MARK: the blind spot this exists to close

    func testSupersessionIsRecordedRatherThanSilentlySkipped() {
        var t = SocketTrace(capacity: 8)
        t.record(ev(1, "S1", .socketOpened(maxMessageBytes: 16_777_216)))
        t.record(ev(2, "S1", .superseded(caller: "receiveLoop")))
        XCTAssertTrue(
            t.events(for: "S1").contains { if case .superseded = $0.kind { return true }; return false },
            "a superseded loop returning silently is precisely why B10 is still open")
    }

    func testLocalDisconnectIsDistinguishableFromAPeerFailure() {
        var t = SocketTrace(capacity: 8)
        t.record(ev(1, "S1", .localDisconnect(caller: "revalidate")))
        t.record(ev(2, "S2", .receiveFailed(domain: "NSPOSIXErrorDomain", code: 57,
                                            closeCode: 1005, closeReason: nil, wasCurrent: true)))
        let localOnly = t.events(for: "S1").contains { if case .localDisconnect = $0.kind { return true }; return false }
        let peerOnly = t.events(for: "S2").contains { if case .receiveFailed = $0.kind { return true }; return false }
        XCTAssertTrue(localOnly && peerOnly,
                      "self-inflicted vs upstream is the fork every B10 branch hangs on")
    }

    // MARK: the failure record must carry the real error, not a localized string

    func testFailureRecordKeepsDomainCodeAndCurrency() {
        var t = SocketTrace(capacity: 8)
        t.record(ev(1, "S1", .receiveFailed(domain: "NSURLErrorDomain", code: -1005,
                                            closeCode: 1006, closeReason: "gone", wasCurrent: false)))
        guard case .receiveFailed(let d, let c, let cc, let reason, let current) =
                t.events(for: "S1").first?.kind else { return XCTFail("failure lost") }
        XCTAssertEqual(d, "NSURLErrorDomain")
        XCTAssertEqual(c, -1005)
        XCTAssertEqual(cc, 1006)
        XCTAssertEqual(reason, "gone")
        XCTAssertFalse(current, "whether the failing socket was still current decides supersession")
    }

    // MARK: bounded memory, newest kept

    func testRingDropsOldestNotNewest() {
        var t = SocketTrace(capacity: 3)
        for i in 1...5 { t.record(ev(Double(i), "S", .received(bytes: i, kind: "text"))) }
        XCTAssertEqual(t.events.count, 3)
        XCTAssertEqual(t.events.first?.at, 3, "oldest dropped")
        XCTAssertEqual(t.events.last?.at, 5, "newest kept — the flap is at the end")
    }

    // MARK: it has to be readable by the operator, or it never reaches me

    func testRenderedTraceCarriesTheFieldsNeededToDecide() {
        var t = SocketTrace(capacity: 8)
        t.record(ev(1, "S1", .connectRequested(origin: .scheduledReconnect)))
        t.record(ev(2, "S1", .socketOpened(maxMessageBytes: 16_777_216)))
        t.record(ev(3, "S1", .upgradeNegotiated(extensions: "permessage-deflate")))
        t.record(ev(4, "S1", .snapshotApplied(bytes: 1_409_526)))
        t.record(ev(5, "S1", .superseded(caller: "receiveLoop")))
        let out = t.rendered()
        for needle in ["S1", "scheduledReconnect", "permessage-deflate", "1409526", "superseded"] {
            XCTAssertTrue(out.contains(needle), "rendered trace must contain \(needle)")
        }
    }

    func testRenderedTraceIsOrderedByTimeEvenIfRecordedOutOfOrder() {
        var t = SocketTrace(capacity: 8)
        t.record(ev(3, "S1", .streamFinished))
        t.record(ev(1, "S1", .connectRequested(origin: .initial)))
        let lines = t.rendered().split(separator: "\n").filter { $0.contains("S1") }
        XCTAssertTrue(lines.first?.contains("connectRequested") == true,
                      "cross-actor writes can arrive out of order; render must sort by stamp")
    }
}
