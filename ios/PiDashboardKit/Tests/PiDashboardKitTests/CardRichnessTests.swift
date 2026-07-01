import XCTest
@testable import PiDashboardKit

/// Session-card richness (parity B4, display-only): decoding the `processes[]` the
/// server already streams (no new network call), plus the pure stat/format helpers
/// the card renders. Verified via `swift test`, no simulator.
final class CardRichnessTests: XCTestCase {

    // MARK: processes[] decoding (the one model gap this batch fills)

    /// A real-shape session patch carrying `processes` decodes into `[ProcessEntry]`.
    /// Byte-shape mirrors `packages/shared/src/types.ts`:
    /// `{ pid, pgid, command, elapsedMs }`.
    func testDecodeProcessesFromSessionJSON() throws {
        let json = """
        {
          "id": "sess-1",
          "status": "streaming",
          "processes": [
            { "pid": 4821, "pgid": 4820, "command": "npm run dev", "elapsedMs": 95000 },
            { "pid": 4830, "pgid": 4820, "command": "vite", "elapsedMs": 4200 }
          ]
        }
        """.data(using: .utf8)!
        let s = try JSONDecoder().decode(DashboardSession.self, from: json)
        let procs = try XCTUnwrap(s.processes)
        XCTAssertEqual(procs.count, 2)
        XCTAssertEqual(procs[0], ProcessEntry(pid: 4821, pgid: 4820, command: "npm run dev", elapsedMs: 95000))
        XCTAssertEqual(procs[0].id, 4821, "ProcessEntry.id == pid")
        XCTAssertEqual(procs[1].command, "vite")
    }

    /// A session WITHOUT `processes` decodes cleanly to nil (field is optional —
    /// the common case; most sessions have no scanned children).
    func testSessionWithoutProcessesDecodesNil() throws {
        let json = #"{"id":"sess-2","status":"idle"}"#.data(using: .utf8)!
        let s = try JSONDecoder().decode(DashboardSession.self, from: json)
        XCTAssertNil(s.processes)
    }

    /// A `session_updated` patch carrying fresh `processes` MERGES onto the session
    /// (the scanner streams process changes via patches, not just the snapshot) — so
    /// the card's process list stays live without any new network call.
    func testProcessesPatchMergesLive() throws {
        var s = DashboardSession(id: "sess-3", status: "streaming")
        XCTAssertNil(s.processes)
        let patchJSON = #"{"processes":[{"pid":1,"pgid":1,"command":"bash","elapsedMs":1000}]}"#.data(using: .utf8)!
        let patch = try JSONDecoder().decode(SessionPatch.self, from: patchJSON)
        patch.apply(to: &s)
        XCTAssertEqual(s.processes?.count, 1)
        XCTAssertEqual(s.processes?.first?.command, "bash")
    }

    // MARK: elapsed (mirrors PWA formatElapsed)

    func testElapsedFormatting() {
        XCTAssertEqual(StatsFormat.elapsed(0), "0s")
        XCTAssertEqual(StatsFormat.elapsed(4200), "4s")
        XCTAssertEqual(StatsFormat.elapsed(59_000), "59s")
        XCTAssertEqual(StatsFormat.elapsed(95_000), "1m 35s")     // 1:35, padded
        XCTAssertEqual(StatsFormat.elapsed(65_000), "1m 05s")     // zero-pad seconds
        XCTAssertEqual(StatsFormat.elapsed(3_600_000), "1h 00m")  // exactly 1h
        XCTAssertEqual(StatsFormat.elapsed(3_900_000), "1h 05m")  // 1:05, padded
        XCTAssertEqual(StatsFormat.elapsed(-500), "0s", "negatives clamp to 0")
    }

    // MARK: cost

    func testCostFormatting() {
        XCTAssertEqual(StatsFormat.cost(1.2345), "$1.23")
        XCTAssertEqual(StatsFormat.cost(0.5), "$0.50")
        XCTAssertNil(StatsFormat.cost(0), "zero cost hidden")
        XCTAssertNil(StatsFormat.cost(nil))
        XCTAssertNil(StatsFormat.cost(-1))
    }

    // MARK: compact tokens

    func testTokensCompact() {
        XCTAssertEqual(StatsFormat.tokensCompact(947), "947")
        XCTAssertEqual(StatsFormat.tokensCompact(12_300), "12.3k")
        XCTAssertEqual(StatsFormat.tokensCompact(1_200_000), "1.2M")
        XCTAssertNil(StatsFormat.tokensCompact(0))
        XCTAssertNil(StatsFormat.tokensCompact(nil))
    }

    func testTotalTokensCompactSumsInAndOut() {
        XCTAssertEqual(StatsFormat.totalTokensCompact(in: 800, out: 200), "1.0k")
        XCTAssertEqual(StatsFormat.totalTokensCompact(in: 500, out: nil), "500")
        XCTAssertNil(StatsFormat.totalTokensCompact(in: nil, out: nil))
    }

    // MARK: command truncation

    func testTruncateCommand() {
        XCTAssertEqual(StatsFormat.truncateCommand("vite", maxLen: 30), "vite")
        let long = String(repeating: "x", count: 50)
        let out = StatsFormat.truncateCommand(long, maxLen: 30)
        XCTAssertEqual(out.count, 30, "29 chars + ellipsis")
        XCTAssertTrue(out.hasSuffix("…"))
    }

    // MARK: context fraction (already in the model — pinned here for the stats row)

    func testContextFraction() {
        var s = DashboardSession(id: "s")
        s.contextTokens = 50_000
        s.contextWindow = 200_000
        XCTAssertEqual(s.contextFraction ?? 0, 0.25, accuracy: 0.0001)

        var none = DashboardSession(id: "s2")
        none.contextWindow = 0
        XCTAssertNil(none.contextFraction, "zero window → nil (no divide-by-zero)")
    }
}
