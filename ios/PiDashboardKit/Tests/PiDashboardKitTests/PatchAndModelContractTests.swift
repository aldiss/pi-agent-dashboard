import XCTest
@testable import PiDashboardKit

/// CONTRACT tests for the two model-layer behaviors the native client's
/// correctness rests on (DESIGN.md §2, brief §2.1):
///   1. `session_updated.updates` is a `Partial<DashboardSession>` — `SessionPatch`
///      must MERGE present fields onto an existing session and leave absent fields
///      untouched (the heart of live delta application).
///   2. `DashboardSession` field-level decode parity — every MVP-relevant field
///      round-trips from the server's real byte shapes, and derived accessors
///      (`displayName`, `contextFraction`, typed enums) compute correctly.
///
/// New file (no collision with the seed `SessionDecodingTests` / `ProtocolTests`).
final class PatchAndModelContractTests: XCTestCase {

    // MARK: - SessionPatch: partial merge semantics

    /// A patch overwrites ONLY its present fields; everything else on the base is
    /// preserved. This is the exact `session_updated` apply contract.
    func testPatchMergesPresentFieldsOnly() throws {
        var base = DashboardSession(id: "s", cwd: "/repo", name: "Original",
                                    source: "tmux", status: "active", startedAt: 1000)
        base.model = "anthropic/opus"
        base.gitBranch = "main"
        base.contextTokens = 50_000
        base.contextWindow = 200_000

        let patch = try JSONDecoder().decode(SessionPatch.self, from: Data(#"""
        {"status":"streaming","currentTool":"bash","contextTokens":51000,"contextWindow":1000000}
        """#.utf8))
        patch.apply(to: &base)

        // changed
        XCTAssertEqual(base.status, "streaming")
        XCTAssertEqual(base.currentTool, "bash")
        XCTAssertEqual(base.contextTokens, 51_000)
        XCTAssertEqual(base.contextWindow, 1_000_000)
        // untouched
        XCTAssertEqual(base.name, "Original")
        XCTAssertEqual(base.cwd, "/repo")
        XCTAssertEqual(base.model, "anthropic/opus")
        XCTAssertEqual(base.gitBranch, "main")
        XCTAssertEqual(base.startedAt, 1000)
    }

    /// Every field the patch supports actually applies (full field-coverage of the
    /// `apply(to:)` merge, so a dropped field can't silently regress).
    func testPatchAppliesEverySupportedField() throws {
        var base = DashboardSession(id: "s")
        let json = Data(#"""
        {"name":"N","status":"idle","model":"p/m","thinkingLevel":"high","endedAt":9,
         "lastActivityAt":8,"unread":true,"tokensIn":1,"tokensOut":2,"cacheRead":3,
         "cacheWrite":4,"cost":0.5,"contextTokens":10,"contextWindow":20,"currentTool":"edit",
         "gitBranch":"b","gitBranchUrl":"http://b","gitPrNumber":7,"hidden":true,
         "firstMessage":"hi","pid":1234,"groupCwd":"/g",
         "worktree":{"branch":"wt","path":"/wt"},
         "progress":{"pct":0.5,"label":"half"},
         "nextEngagement":{"effort":"short","note":"n"},
         "processMetrics":{"rss":100,"cpuPercent":2.5}}
        """#.utf8)
        let patch = try JSONDecoder().decode(SessionPatch.self, from: json)
        patch.apply(to: &base)

        XCTAssertEqual(base.name, "N")
        XCTAssertEqual(base.status, "idle")
        XCTAssertEqual(base.model, "p/m")
        XCTAssertEqual(base.thinkingLevel, "high")
        XCTAssertEqual(base.endedAt, 9)
        XCTAssertEqual(base.lastActivityAt, 8)
        XCTAssertEqual(base.unread, true)
        XCTAssertEqual(base.tokensIn, 1)
        XCTAssertEqual(base.tokensOut, 2)
        XCTAssertEqual(base.cacheRead, 3)
        XCTAssertEqual(base.cacheWrite, 4)
        XCTAssertEqual(base.cost, 0.5)
        XCTAssertEqual(base.contextTokens, 10)
        XCTAssertEqual(base.contextWindow, 20)
        XCTAssertEqual(base.currentTool, "edit")
        XCTAssertEqual(base.gitBranch, "b")
        XCTAssertEqual(base.gitBranchUrl, "http://b")
        XCTAssertEqual(base.gitPrNumber, 7)
        XCTAssertEqual(base.hidden, true)
        XCTAssertEqual(base.firstMessage, "hi")
        XCTAssertEqual(base.pid, 1234)
        XCTAssertEqual(base.groupCwd, "/g")
        XCTAssertEqual(base.worktree, Worktree(branch: "wt", path: "/wt"))
        XCTAssertEqual(base.progress?.pct, 0.5)
        XCTAssertEqual(base.progress?.label, "half")
        XCTAssertEqual(base.nextEngagement?.effort, "short")
        XCTAssertEqual(base.processMetrics?.rss, 100)
        XCTAssertEqual(base.processMetrics?.cpuPercent, 2.5)
    }

    /// An empty patch (`{}`) is a no-op — it never nulls existing fields. (The TS
    /// `Partial` semantics: absent ≠ null.)
    func testEmptyPatchIsNoOp() throws {
        var base = DashboardSession(id: "s", name: "Keep", status: "active")
        base.model = "p/m"
        let before = base
        let patch = try JSONDecoder().decode(SessionPatch.self, from: Data("{}".utf8))
        patch.apply(to: &base)
        XCTAssertEqual(base, before, "empty patch changes nothing")
    }

    /// Sequential patches accumulate (a live stream of `session_updated`s) — the
    /// last writer wins per field, others persist.
    func testSequentialPatchesAccumulate() throws {
        var base = DashboardSession(id: "s", status: "active")
        try JSONDecoder().decode(SessionPatch.self, from: Data(#"{"status":"streaming"}"#.utf8)).apply(to: &base)
        try JSONDecoder().decode(SessionPatch.self, from: Data(#"{"currentTool":"bash"}"#.utf8)).apply(to: &base)
        try JSONDecoder().decode(SessionPatch.self, from: Data(#"{"status":"idle"}"#.utf8)).apply(to: &base)
        XCTAssertEqual(base.status, "idle", "last status wins")
        XCTAssertEqual(base.currentTool, "bash", "interim field persists")
    }

    // MARK: - DashboardSession: field-level decode parity

    func testDecodeFullSessionRoundTrip() throws {
        let json = Data(#"""
        {"id":"abc","cwd":"/Users/op/proj","name":"Worker","source":"claude-code",
         "status":"streaming","model":"anthropic/claude-opus-4","thinkingLevel":"medium",
         "startedAt":1000,"lastActivityAt":2000,"unread":true,
         "contextTokens":120000,"contextWindow":200000,"currentTool":"bash",
         "gitBranch":"feat/x","gitPrNumber":42,
         "worktree":{"branch":"feat/x","path":"/wt/x"},"groupCwd":"/Users/op/proj",
         "progress":{"pct":0.75,"label":"finishing","milestonesDone":3,"milestonesTotal":4},
         "nextEngagement":{"effort":"one-action","note":"approve"},
         "processMetrics":{"rss":2048,"cpuPercent":1.2,"loadAvg1m":3.5}}
        """#.utf8)
        let s = try JSONDecoder().decode(DashboardSession.self, from: json)

        XCTAssertEqual(s.id, "abc")
        XCTAssertEqual(s.sourceEnum, .claudeCode, "hyphenated source enum")
        XCTAssertEqual(s.statusEnum, .streaming)
        XCTAssertEqual(s.thinkingLevel, "medium")
        XCTAssertEqual(s.gitPrNumber, 42)
        XCTAssertEqual(s.worktree?.path, "/wt/x")
        XCTAssertEqual(s.progress?.milestonesTotal, 4)
        XCTAssertEqual(s.nextEngagement?.effort, "one-action")
        XCTAssertEqual(s.processMetrics?.loadAvg1m, 3.5)
        // derived
        XCTAssertEqual(try XCTUnwrap(s.contextFraction), 0.6, accuracy: 0.0001)
        XCTAssertEqual(s.displayName, "Worker")
        XCTAssertFalse(s.isEnded)
    }

    /// `displayName` fallback chain: name → first line of firstMessage → cwd basename → id.
    func testDisplayNameFallbackChain() {
        XCTAssertEqual(DashboardSession(id: "i", name: "Named").displayName, "Named")
        XCTAssertEqual(
            DashboardSession(id: "i", firstMessage: "First line\nsecond line").displayName,
            "First line", "multi-line firstMessage → first line only")
        XCTAssertEqual(DashboardSession(id: "i", cwd: "/a/b/pi-shodh").displayName, "pi-shodh")
        XCTAssertEqual(DashboardSession(id: "bare-id").displayName, "bare-id", "nothing → id")
        // whitespace-only name is skipped, falls through to firstMessage.
        XCTAssertEqual(
            DashboardSession(id: "i", name: "   ", firstMessage: "real").displayName,
            "real", "blank name falls through")
    }

    /// `contextFraction` is clamped to 0...1 and nil when inputs are missing / zero-window.
    func testContextFractionMath() throws {
        XCTAssertEqual(try XCTUnwrap(make(ctx: 50_000, win: 200_000).contextFraction), 0.25, accuracy: 1e-9)
        XCTAssertEqual(make(ctx: 250_000, win: 200_000).contextFraction, 1.0, "over-full clamps to 1")
        XCTAssertNil(make(ctx: 1, win: 0).contextFraction, "zero window → nil (no divide-by-zero)")
        XCTAssertNil(make(ctx: nil, win: 200_000).contextFraction, "missing tokens → nil")
    }

    private func make(ctx: Double?, win: Double?) -> DashboardSession {
        var s = DashboardSession(id: "s")
        s.contextTokens = ctx; s.contextWindow = win
        return s
    }

    /// `ImageContent` always encodes its constant `type:"image"` discriminator
    /// (pi SDK shape) regardless of how it was constructed.
    func testImageContentTypeDiscriminator() throws {
        let img = ImageContent(data: "AAAA", mimeType: "image/png")
        XCTAssertEqual(img.type, "image")
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(img)) as? [String: Any])
        XCTAssertEqual(obj["type"] as? String, "image")
        XCTAssertEqual(obj["mimeType"] as? String, "image/png")
    }

    /// `ApiResponse<T>` envelope decodes both the wrapped success shape and an
    /// error shape — the REST contract the connect/load paths depend on.
    func testApiResponseEnvelope() throws {
        let ok = try JSONDecoder().decode(ApiResponse<[DashboardSession]>.self,
            from: Data(#"{"success":true,"data":[{"id":"a"}]}"#.utf8))
        XCTAssertEqual(ok.success, true)
        XCTAssertEqual(ok.data?.count, 1)
        XCTAssertNil(ok.error)

        let err = try JSONDecoder().decode(ApiResponse<[DashboardSession]>.self,
            from: Data(#"{"success":false,"error":"nope","code":"E_X"}"#.utf8))
        XCTAssertEqual(err.success, false)
        XCTAssertEqual(err.error, "nope")
        XCTAssertEqual(err.code, "E_X")
        XCTAssertNil(err.data)
    }
}
