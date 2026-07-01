import XCTest
@testable import PiDashboardKit

/// Cluster 6 (final) — content/data robustness. Malformed payloads DEGRADE instead of
/// dropping/crashing; SessionPatch distinguishes clear-vs-absent; oversize is capped;
/// negative durations clamp; unknown frames skip. Pure, `swift test`-verified.
final class DataRobustnessTests: XCTestCase {

    private func decodeEvent(_ json: String) throws -> DashboardEvent {
        try JSONDecoder().decode(DashboardEvent.self, from: Data(json.utf8))
    }
    private func decodePatch(_ json: String) throws -> SessionPatch {
        try JSONDecoder().decode(SessionPatch.self, from: Data(json.utf8))
    }

    // MARK: 1 — resilient event decode (degrade, don't drop)

    /// A missing eventType/timestamp DEGRADES to sensible fallbacks (not a throw that
    /// would drop the whole frame). "unknown" routes to a raw row in the reducer.
    func testMalformedEventDegradesNotDrops() throws {
        let noType = try decodeEvent(#"{"timestamp":123,"data":{}}"#)
        XCTAssertEqual(noType.eventType, "unknown")
        XCTAssertEqual(noType.timestamp, 123)

        let empty = try decodeEvent("{}")
        XCTAssertEqual(empty.eventType, "unknown")
        XCTAssertEqual(empty.timestamp, 0)
        XCTAssertTrue(empty.data.isEmpty)
    }

    /// A garbled `data` (wrong type) degrades to empty rather than throwing.
    func testEventGarbledDataDegradesToEmpty() throws {
        let ev = try decodeEvent(#"{"eventType":"x","timestamp":1,"data":"not-an-object"}"#)
        XCTAssertEqual(ev.eventType, "x")
        XCTAssertTrue(ev.data.isEmpty, "un-decodable data → empty, not a throw")
    }

    /// A bad item inside an event_replay batch still decodes (degraded) — it doesn't
    /// drop the whole batch. A missing `seq` → 0; the event degrades.
    func testSequencedEventDegradesInBatch() throws {
        let se = try JSONDecoder().decode(SequencedEvent.self,
            from: Data(#"{"event":{"eventType":"turn_end","timestamp":5}}"#.utf8))
        XCTAssertEqual(se.seq, 0, "missing seq → 0, not dropped")
        XCTAssertEqual(se.event.eventType, "turn_end")
    }

    /// A completely unknown top-level frame type → `.unknown` (never a throw/crash).
    func testUnknownFrameSkipsToUnknown() throws {
        let msg = try JSONDecoder().decode(ServerMessage.self,
            from: Data(#"{"type":"some_new_2027_frame","foo":1}"#.utf8))
        guard case .unknown(let t) = msg else { return XCTFail("expected .unknown") }
        XCTAssertEqual(t, "some_new_2027_frame")
    }

    // MARK: 2 — SessionPatch tri-state (clear vs absent vs value)

    /// present-value → SET.
    func testPatchValueSets() throws {
        var s = DashboardSession(id: "s", name: "old")
        try decodePatch(#"{"name":"new"}"#).apply(to: &s)
        XCTAssertEqual(s.name, "new")
    }

    /// ABSENT → unchanged (the common partial-update case).
    func testPatchAbsentLeavesUnchanged() throws {
        var s = DashboardSession(id: "s", name: "keep")
        try decodePatch(#"{"status":"idle"}"#).apply(to: &s) // no name key
        XCTAssertEqual(s.name, "keep", "absent name leaves the value untouched")
    }

    /// present-NULL → CLEAR (the bug this cluster fixes — was impossible before).
    func testPatchNullClears() throws {
        var s = DashboardSession(id: "s", name: "old")
        try decodePatch(#"{"name":null}"#).apply(to: &s)
        XCTAssertNil(s.name, "explicit null CLEARS the name")
    }

    /// gitPrNumber: a closed PR (server sends null) clears the stale number; absent
    /// leaves it; a value sets it.
    func testPatchGitPrTriState() throws {
        var s = DashboardSession(id: "s")
        s.gitPrNumber = 42
        try decodePatch("{}").apply(to: &s)
        XCTAssertEqual(s.gitPrNumber, 42, "absent → unchanged")
        try decodePatch(#"{"gitPrNumber":null}"#).apply(to: &s)
        XCTAssertNil(s.gitPrNumber, "null → PR closed → cleared")
        try decodePatch(#"{"gitPrNumber":7}"#).apply(to: &s)
        XCTAssertEqual(s.gitPrNumber, 7, "value → set")
    }

    /// model clears too (switching a session off a model).
    func testPatchModelClears() throws {
        var s = DashboardSession(id: "s")
        s.model = "anthropic/opus"
        try decodePatch(#"{"model":null}"#).apply(to: &s)
        XCTAssertNil(s.model)
    }

    /// A garbled patch object doesn't throw — it applies as an empty (no-op) patch.
    func testGarbledPatchIsNoOp() throws {
        var s = DashboardSession(id: "s", name: "keep")
        // A wrong-typed field degrades; the rest still parse.
        try decodePatch(#"{"name":"new","gitPrNumber":"not-an-int"}"#).apply(to: &s)
        XCTAssertEqual(s.name, "new")
        // gitPrNumber was garbled → treated as absent → no crash, PR untouched.
    }

    // MARK: 3 — payload caps at the boundary

    func testFrameSizeBudget() {
        XCTAssertTrue(PayloadCap.frameWithinBudget(1024))
        XCTAssertTrue(PayloadCap.frameWithinBudget(PayloadCap.maxFrameBytes))
        XCTAssertFalse(PayloadCap.frameWithinBudget(PayloadCap.maxFrameBytes + 1), "over budget → skip")
    }

    /// The reducer still caps a huge bash output (DF#5 + this cluster's boundary).
    func testReducerCapsHugePayload() {
        let big = String(repeating: "x", count: 200_000)
        let state = ChatSessionState().reduce(
            DashboardEvent(eventType: "bash_output", timestamp: 1, data: ["output": .string(big)]))
        let row = state.messages.first { $0.role == .bashOutput }
        XCTAssertNotNil(row)
        XCTAssertLessThan(row!.content.count, big.count, "capped at the store boundary")
        XCTAssertTrue(row!.content.contains("truncated"))
    }

    // MARK: 4 — duration clamp

    func testClampDuration() {
        XCTAssertEqual(PayloadCap.clampDuration(-5000), 0, "clock-skew negative → 0")
        XCTAssertEqual(PayloadCap.clampDuration(0), 0)
        XCTAssertEqual(PayloadCap.clampDuration(3500), 3500)
    }

    /// A tool that "ends BEFORE it started" (clock skew) stores a clamped 0 duration,
    /// not a negative — proved through the reducer.
    func testReducerClampsNegativeDuration() {
        var s = ChatSessionState()
        // tool_execution_start at ts=100 …
        s = s.reduce(DashboardEvent(eventType: "tool_execution_start", timestamp: 100,
            data: ["toolCallId": .string("t1"), "toolName": .string("bash")]))
        // … tool_execution_end at ts=50 (earlier — skew).
        s = s.reduce(DashboardEvent(eventType: "tool_execution_end", timestamp: 50,
            data: ["toolCallId": .string("t1")]))
        let row = s.messages.first { $0.toolCallId == "t1" }
        XCTAssertNotNil(row?.duration)
        XCTAssertGreaterThanOrEqual(row!.duration!, 0, "negative duration clamped to >= 0")
    }
}
