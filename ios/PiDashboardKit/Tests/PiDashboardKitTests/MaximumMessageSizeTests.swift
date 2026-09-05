import XCTest
@testable import PiDashboardKit

/// B10 root cause, pinned.
///
/// URLSession defaults `maximumMessageSize` to 1 MB and CLOSES the socket when a
/// single message exceeds it. The dashboard server compresses `sessions_snapshot`
/// with permessage-deflate and re-ships it on EVERY (re)connect, but
/// `URLSessionWebSocketTask` cannot negotiate permessage-deflate, so this client
/// receives it uncompressed. Measured live on 2026-09-05: 1,409,526 bytes — 34%
/// over the default. The socket was accepted, carried the snapshot, and was then
/// torn down by URLSession itself, every ~2.4s, indefinitely.
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
