import XCTest
@testable import PiDashboardKit

/// Guards a REAL but CONDITIONAL failure mode. NOT a proven B10 root cause.
///
/// CORRECTION (2026-09-05, independent cross-model audit): an earlier version of this
/// file asserted URLSession cannot negotiate permessage-deflate. That is FALSE. The
/// server observed `Sec-WebSocket-Extensions: permessage-deflate` on the native
/// request, and a 1.43 MB logical snapshot arrived intact with the limit still at its
/// 1 MB default. Cloudflare was cleared too: it carried a 1,453,441-byte UNCOMPRESSED
/// snapshot through the production tunnel without dropping. So the operator's flap is
/// NOT explained by this ceiling, and the root cause is still open.
///
/// URLSession defaults `maximumMessageSize` to 1 MB and CLOSES the socket when a
/// single message exceeds it. The dashboard server compresses `sessions_snapshot`
/// and re-ships it on EVERY (re)connect. When compression is NOT negotiated — a
/// server config change, a proxy stripping the extension header, a future client —
/// the uncompressed frame (1,409,526 bytes measured live) exceeds the default and
/// every connection is severed at snapshot time. That path was reproduced
/// deliberately on loopback: uncompressed at a 1 MB cap fails, compressed passes.
///
/// These assertions fail if anyone restores the default or trims the ceiling back
/// under the real payload, which would silently reintroduce the flap.
final class MaximumMessageSizeTests: XCTestCase {

    /// The uncompressed `sessions_snapshot` measured on the operator's own server
    /// the day B10 was diagnosed. The ceiling must clear this, not merely 1 MB.
    private let measuredSnapshotBytes = 1_409_526

    /// URLSession's default, and the value that was actually binding in production.
    private let urlSessionDefault = 1_048_576

    func testCeilingExceedsUrlSessionDefault() {
        XCTAssertGreaterThan(
            DashboardClient.maximumIncomingMessageBytes, urlSessionDefault,
            "at or below the 1 MB default the socket is closed by URLSession itself")
    }

    func testCeilingClearsTheRealMeasuredSnapshot() {
        XCTAssertGreaterThan(
            DashboardClient.maximumIncomingMessageBytes, measuredSnapshotBytes,
            "a ceiling under the real payload reproduces B10 exactly")
    }

    /// The snapshot grows with the operator's session count — it was ~345 KB at ~380
    /// sessions and is now ~1.34 MB. A ceiling that merely clears today's payload
    /// would fail again as sessions accumulate, so require real headroom.
    func testCeilingKeepsHeadroomForGrowth() {
        XCTAssertGreaterThanOrEqual(
            DashboardClient.maximumIncomingMessageBytes, measuredSnapshotBytes * 4,
            "the payload grows with session count; a ceiling with no headroom re-breaks")
    }

    /// Guards the arithmetic itself: 16 MB must be what we think it is.
    func testCeilingIsSixteenMebibytes() {
        XCTAssertEqual(DashboardClient.maximumIncomingMessageBytes, 16_777_216)
    }
}
