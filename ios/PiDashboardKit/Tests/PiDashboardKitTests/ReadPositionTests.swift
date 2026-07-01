import XCTest
@testable import PiDashboardKit

/// DF#3 — read-position persistence + engagement-weighted (Tier-A) unread. Pure +
/// UserDefaults-injectable, verified via `swift test`, no simulator.
final class ReadPositionTests: XCTestCase {

    // MARK: ReadPositionStore (per-session last-read id)

    private func ephemeral() -> (UserDefaults, String) {
        let suite = "pi.dashboard.readpos.tests.\(UUID().uuidString)"
        return (UserDefaults(suiteName: suite)!, suite)
    }

    func testReadPositionDefaultsNilWhenNeverRead() {
        let (d, suite) = ephemeral()
        defer { d.removePersistentDomain(forName: suite) }
        XCTAssertNil(ReadPositionStore.load("s1", from: d))
    }

    func testReadPositionRoundTrips() {
        let (d, suite) = ephemeral()
        defer { d.removePersistentDomain(forName: suite) }
        ReadPositionStore.save("s1", messageId: "msg-42", to: d)
        XCTAssertEqual(ReadPositionStore.load("s1", from: d), "msg-42")
        // Per-session isolation.
        XCTAssertNil(ReadPositionStore.load("s2", from: d))
    }

    func testReadPositionClearAndEmptyClears() {
        let (d, suite) = ephemeral()
        defer { d.removePersistentDomain(forName: suite) }
        ReadPositionStore.save("s1", messageId: "msg-1", to: d)
        ReadPositionStore.clear("s1", from: d)
        XCTAssertNil(ReadPositionStore.load("s1", from: d))
        // Saving an empty id also clears.
        ReadPositionStore.save("s1", messageId: "msg-2", to: d)
        ReadPositionStore.save("s1", messageId: "", to: d)
        XCTAssertNil(ReadPositionStore.load("s1", from: d))
    }

    // MARK: UnreadCounter (Tier-A weighted)

    /// A user text, an ask_user (tierA), a bash tool-call (toolCalls), an assistant
    /// (meshChatter) — the transcript shape the operator sees.
    private func transcript() -> [ChatMessage] {
        [
            ChatMessage(id: "m0", role: .user, content: "go", timestamp: 0),
            ChatMessage(id: "m1", role: .assistant, content: "on it", timestamp: 1),
            ChatMessage(id: "m2", role: .toolResult, content: "bash", toolName: "bash", timestamp: 2),
            ChatMessage(id: "m3", role: .toolResult, content: "ask", toolName: "ask_user", timestamp: 3), // tierA
            ChatMessage(id: "m4", role: .toolResult, content: "bash", toolName: "bash", timestamp: 4),
            ChatMessage(id: "m5", role: .toolResult, content: "ask2", toolName: "ask_user", timestamp: 5), // tierA
        ]
    }

    /// Never read → the WHOLE transcript is unread; both asks count, first-unread is
    /// the first row, first-unread-ask is the first ask_user.
    func testNilLastReadCountsAllTierA() {
        let s = UnreadCounter.summarize(transcript(), lastReadId: nil)
        XCTAssertEqual(s.tierAUnread, 2, "both ask_user rows counted; tool-calls ignored")
        XCTAssertEqual(s.firstUnreadId, "m0")
        XCTAssertEqual(s.firstUnreadTierAId, "m3", "first operator-direct ask")
    }

    /// Read up to m2 → only the asks AFTER m2 count (m3, m5). The two bash tool-calls
    /// (m2, m4) never count — the whole point (agents spam tool-calls).
    func testCountsTierAAfterReadPositionIgnoringToolCalls() {
        let s = UnreadCounter.summarize(transcript(), lastReadId: "m2")
        XCTAssertEqual(s.tierAUnread, 2)
        XCTAssertEqual(s.firstUnreadId, "m3")
        XCTAssertEqual(s.firstUnreadTierAId, "m3")
    }

    /// Read past the first ask (up to m3) → only the second ask remains unread.
    func testReadPastFirstAskLeavesSecond() {
        let s = UnreadCounter.summarize(transcript(), lastReadId: "m3")
        XCTAssertEqual(s.tierAUnread, 1)
        XCTAssertEqual(s.firstUnreadId, "m4", "first unread row is the bash after m3")
        XCTAssertEqual(s.firstUnreadTierAId, "m5", "…but the first unread ASK is m5")
    }

    /// Read to the last message → zero unread, no anchors.
    func testReadToEndIsZeroUnread() {
        let s = UnreadCounter.summarize(transcript(), lastReadId: "m5")
        XCTAssertEqual(s, .none)
        XCTAssertEqual(s.tierAUnread, 0)
        XCTAssertNil(s.firstUnreadId)
    }

    /// A stale / unknown last-read id (message evicted) → treat everything as unread
    /// (never silently hide asks).
    func testUnknownLastReadTreatedAsAllUnread() {
        let s = UnreadCounter.summarize(transcript(), lastReadId: "does-not-exist")
        XCTAssertEqual(s.tierAUnread, 2)
        XCTAssertEqual(s.firstUnreadId, "m0")
    }

    /// A transcript with NO asks → zero weighted unread even with unread rows (raw
    /// tool-call spam is not "unread" for the operator).
    func testNoAsksMeansZeroWeightedUnread() {
        let toolsOnly = [
            ChatMessage(id: "t0", role: .toolResult, content: "bash", toolName: "bash", timestamp: 0),
            ChatMessage(id: "t1", role: .toolResult, content: "read", toolName: "read", timestamp: 1),
        ]
        let s = UnreadCounter.summarize(toolsOnly, lastReadId: nil)
        XCTAssertEqual(s.tierAUnread, 0, "tool-call flood is NOT weighted unread")
        XCTAssertEqual(s.firstUnreadId, "t0", "…but there IS unread content (divider still anchors)")
        XCTAssertNil(s.firstUnreadTierAId, "no ask to jump to")
    }

    func testEmptyTranscriptIsNone() {
        XCTAssertEqual(UnreadCounter.summarize([], lastReadId: nil), .none)
        XCTAssertEqual(UnreadCounter.tierAUnreadCount([], lastReadId: "x"), 0)
    }

    func testTierAUnreadCountConvenience() {
        XCTAssertEqual(UnreadCounter.tierAUnreadCount(transcript(), lastReadId: "m2"), 2)
    }
}
