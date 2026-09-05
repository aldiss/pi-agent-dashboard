import XCTest
@testable import PiDashboardKit

/// Where a chat lands when you open it.
///
/// Operator report 2026-09-05: opening a session requires scrolling all the way down
/// to reach the newest message. Cause: `restoreOnOpen` resolved its anchor as
/// `lastReadId ?? firstUnreadId`, and `UnreadCounter` defines a session with NO read
/// position as *entirely* unread — so `firstUnreadId` is the OLDEST message in the
/// list. A session opened for the first time therefore anchored to the very top.
///
/// The intent, in the operator's words: a session opened before should return to
/// where he was; a session opened for the FIRST time should go straight to the end.
final class ChatOpenPolicyTests: XCTestCase {

    func testFirstTimeOpenGoesToTheBottom() {
        // Never opened here: no read position. Everything is "unread", so the first
        // unread id is the OLDEST message — anchoring to it is the reported bug.
        XCTAssertEqual(
            ChatOpenPolicy.anchor(lastReadId: nil, firstUnreadId: "oldest-message"),
            .bottom,
            "a session never opened here must land at the newest message, not the first")
    }

    func testPreviouslyOpenedSessionResumesWhereItLeftOff() {
        XCTAssertEqual(
            ChatOpenPolicy.anchor(lastReadId: "m42", firstUnreadId: "m43"),
            .message(id: "m42"),
            "a session opened before must return to the operator's place")
    }

    func testResumeWinsEvenWhenUnreadMessagesArrivedAfter() {
        // The whole point of resume is to return to his position, not to jump forward.
        XCTAssertEqual(
            ChatOpenPolicy.anchor(lastReadId: "m10", firstUnreadId: "m11"),
            .message(id: "m10"))
    }

    func testEmptySessionGoesToBottomRatherThanNowhere() {
        XCTAssertEqual(
            ChatOpenPolicy.anchor(lastReadId: nil, firstUnreadId: nil), .bottom)
    }

    /// A stale read id (message since evicted) must not strand the view. The caller
    /// verifies presence, but the policy must express the fallback rather than leave
    /// it implicit — an unresolvable anchor previously fell through to `.bottom` by
    /// accident, and accidental behaviour is not a contract.
    func testBottomIsTheFallbackWhenThereIsNoUsableReadPosition() {
        XCTAssertEqual(ChatOpenPolicy.anchor(lastReadId: nil, firstUnreadId: "x"), .bottom)
    }
}
