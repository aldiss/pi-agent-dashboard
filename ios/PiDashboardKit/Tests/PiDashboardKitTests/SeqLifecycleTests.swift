import XCTest
@testable import PiDashboardKit

/// Cluster 1 (P0 blocker) — the event-replay / seq lifecycle rules that keep chat
/// history from duplicating (reopen/reconnect), dedup live events, and resume from
/// the right point. Pure decision helpers + a reduce-level proof of WHY
/// reset-before-full-replay is required. `swift test`, no socket.
final class SeqLifecycleTests: XCTestCase {

    // MARK: subscribe resume point

    /// First open (nothing applied) → subscribe with nil = full replay; a reopen with
    /// a known last-seen → resume from it.
    func testSubscribeLastSeqNilFirstThenResume() {
        XCTAssertNil(SeqLifecycle.subscribeLastSeq(lastSeen: nil), "first open → full replay")
        XCTAssertEqual(SeqLifecycle.subscribeLastSeq(lastSeen: 42), 42, "reopen → resume from last applied")
    }

    func testExpectsFullReplayOnlyWhenNil() {
        XCTAssertTrue(SeqLifecycle.expectsFullReplay(lastSeq: nil))
        XCTAssertFalse(SeqLifecycle.expectsFullReplay(lastSeq: 0), "seq 0 is a real resume point, not full")
        XCTAssertFalse(SeqLifecycle.expectsFullReplay(lastSeq: 99))
    }

    // MARK: live-event dedup + out-of-order

    func testShouldApplyOnlyNewerSeq() {
        XCTAssertTrue(SeqLifecycle.shouldApply(seq: 5, lastSeen: nil), "nothing applied yet → apply")
        XCTAssertTrue(SeqLifecycle.shouldApply(seq: 6, lastSeen: 5), "newer → apply")
        XCTAssertFalse(SeqLifecycle.shouldApply(seq: 5, lastSeen: 5), "DUPLICATE seq → drop")
        XCTAssertFalse(SeqLifecycle.shouldApply(seq: 3, lastSeen: 5), "OUT-OF-ORDER older seq → drop")
    }

    func testAdvanceIsMonotonic() {
        XCTAssertEqual(SeqLifecycle.advance(lastSeen: nil, appliedSeq: 7), 7)
        XCTAssertEqual(SeqLifecycle.advance(lastSeen: 7, appliedSeq: 9), 9)
        XCTAssertEqual(SeqLifecycle.advance(lastSeen: 9, appliedSeq: 4), 9, "never rewinds")
    }

    func testAdvanceBatchMax() {
        XCTAssertEqual(SeqLifecycle.advance(lastSeen: nil, batchMaxSeq: 12), 12)
        XCTAssertEqual(SeqLifecycle.advance(lastSeen: 20, batchMaxSeq: 12), 20, "keeps the larger")
        XCTAssertEqual(SeqLifecycle.advance(lastSeen: 5, batchMaxSeq: 30), 30)
        XCTAssertNil(SeqLifecycle.advance(lastSeen: nil, batchMaxSeq: nil))
    }

    // MARK: reset-before-full-replay proof (the duplicate-history root cause)

    private func userEvents(_ n: Int) -> [DashboardEvent] {
        (0..<n).map { i in
            DashboardEvent(eventType: "message_start", timestamp: Double(i),
                           data: ["message": .object(["role": .string("user"),
                                                       "content": .string("msg \(i)")])])
        }
    }

    /// Reducing a full replay onto ALREADY-populated state DUPLICATES rows — this is
    /// exactly the reopen bug. Reducing onto FRESH state does not. This documents WHY
    /// the store must reset `chatStates[sid]` before an authoritative full replay.
    func testReplayOntoExistingDuplicatesButResetDoesNot() {
        let history = userEvents(3)
        // First open: fold onto fresh state → 3 rows.
        let firstOpen = ChatSessionState().reduce(events: history)
        XCTAssertEqual(firstOpen.messages.filter { $0.role == .user }.count, 3)

        // BUG path: a second full replay folded onto the existing state → 6 rows.
        let duped = firstOpen.reduce(events: history)
        XCTAssertEqual(duped.messages.filter { $0.role == .user }.count, 6,
                       "replay onto existing state DUPLICATES — the reopen bug")

        // FIX path: reset (fresh state) before the authoritative replay → back to 3.
        let reset = ChatSessionState().reduce(events: history)
        XCTAssertEqual(reset.messages.filter { $0.role == .user }.count, 3,
                       "reset-before-replay → no duplication")
    }

    /// End-to-end rule sketch: on reopen we resume with lastSeq, so the server sends
    /// only NEW events (not a full replay) — no reset, and dedup drops any overlap.
    func testResumePathAppliesOnlyNewSeqs() {
        var lastSeen: Int? = 5
        // Server (resume) sends seq 4 (overlap, already applied), 6, 7 (new).
        var applied: [Int] = []
        for seq in [4, 6, 7] where SeqLifecycle.shouldApply(seq: seq, lastSeen: lastSeen) {
            applied.append(seq)
            lastSeen = SeqLifecycle.advance(lastSeen: lastSeen, appliedSeq: seq)
        }
        XCTAssertEqual(applied, [6, 7], "overlap seq 4 dropped; only new seqs applied")
        XCTAssertEqual(lastSeen, 7)
    }
}
