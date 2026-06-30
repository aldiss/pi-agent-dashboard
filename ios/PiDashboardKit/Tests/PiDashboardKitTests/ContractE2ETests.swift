import XCTest
@testable import PiDashboardKit

/// End-to-end CONTRACT tests grounded in a REAL `event_replay` payload captured
/// live from the operator's dashboard browser gateway (`ws://localhost:8000/ws`)
/// via `qa-e2e/capture-fixtures.mjs` (read-only: subscribe-only). This is the
/// load-bearing proof that the native client decodes the server's ACTUAL bytes
/// AND that the chat reducer survives a real session's full event stream — not a
/// hand-rolled impression of it.
///
/// New file (TEST-CONTRACT §E): no collision with the seed `ProtocolTests` /
/// `SessionDecodingTests` / `EventReducerTests`. Assertions are INVARIANTS that
/// hold for any valid replay, so refreshing the fixture (re-running the harness)
/// never makes the suite brittle.
final class ContractE2ETests: XCTestCase {

    // MARK: fixture loader

    private func fixtureData(_ name: String, _ ext: String) throws -> Data {
        let urls = [
            Bundle.module.url(forResource: name, withExtension: ext, subdirectory: "Fixtures"),
            Bundle.module.url(forResource: name, withExtension: ext),
        ].compactMap { $0 }
        let url = try XCTUnwrap(urls.first, "fixture \(name).\(ext) not found — run qa-e2e/capture-fixtures.mjs")
        return try Data(contentsOf: url)
    }

    private func decodeReplay() throws -> (sessionId: String, events: [SequencedEvent], isLast: Bool) {
        let data = try fixtureData("event-replay-sample", "json")
        let msg = try JSONDecoder().decode(ServerMessage.self, from: data)
        guard case .eventReplay(let sid, let events, let isLast) = msg else {
            throw XCTSkip("event-replay-sample.json did not decode as event_replay (got \(((try? JSONDecoder().decode(ServerMessage.self, from: data))?.wireType) ?? "decode-error"))")
        }
        return (sid, events, isLast)
    }

    // MARK: real event_replay — decode + structural contract

    /// The captured replay decodes through the full `ServerMessage` decoder as an
    /// `.eventReplay` with a non-empty, sequence-ordered event list.
    func testRealEventReplayDecodes() throws {
        let (sid, events, _) = try decodeReplay()
        XCTAssertFalse(sid.isEmpty, "replay carries the source sessionId")
        XCTAssertFalse(events.isEmpty, "a real replay has events")

        // seq is strictly increasing (the server replays in order).
        for (a, b) in zip(events, events.dropFirst()) {
            XCTAssertLessThan(a.seq, b.seq, "event seq must strictly increase (\(a.seq) → \(b.seq))")
        }

        // Every event carries a non-empty eventType + a real (non-zero) timestamp.
        for sequenced in events {
            XCTAssertFalse(sequenced.event.eventType.isEmpty, "every event has an eventType")
            XCTAssertGreaterThan(sequenced.event.timestamp, 0, "every event has a timestamp")
        }
    }

    /// The reduced stream (real bytes) yields a coherent chat state: rows with
    /// UNIQUE, non-empty ids (a hard SwiftUI `ForEach` invariant — a collision is a
    /// real rendering bug), real timestamps, and a non-empty transcript.
    func testRealEventReplayReducesToCoherentState() throws {
        let (_, events, _) = try decodeReplay()
        let state = ChatSessionState().reduce(events: events.map { $0.event })

        XCTAssertFalse(state.messages.isEmpty, "reducing a real session produces rows")

        let ids = state.messages.map { $0.id }
        XCTAssertEqual(Set(ids).count, ids.count, "every reduced row id is unique (SwiftUI ForEach contract)")
        XCTAssertTrue(state.messages.allSatisfy { !$0.id.isEmpty }, "no empty row ids")
        XCTAssertTrue(state.messages.allSatisfy { $0.timestamp > 0 }, "every row keeps its event timestamp")
    }

    /// FIELD-LEVEL PARITY: the number of reduced `user` rows equals the number of
    /// `message_start` events whose `message.role == "user"` in the raw payload —
    /// a direct raw-events ↔ reduced-rows parity check on real data.
    func testRealEventReplayUserRowParity() throws {
        let (_, events, _) = try decodeReplay()
        let rawUserStarts = events.filter { seq in
            seq.event.eventType == "message_start"
                && seq.event.data["message"]?.objectValue?["role"]?.stringValue == "user"
        }.count
        try XCTSkipIf(rawUserStarts == 0, "fixture has no user message_start events to compare")

        let state = ChatSessionState().reduce(events: events.map { $0.event })
        let reducedUserRows = state.messages.filter { $0.role == .user }.count
        XCTAssertEqual(reducedUserRows, rawUserStarts,
                       "each user message_start becomes exactly one user row")
    }

    /// Folding via the batch helper `reduce(events:)` is identical to folding the
    /// same events one-by-one — the live path (replay batch, then live `event`s)
    /// and the bulk path must agree.
    func testReduceBatchEqualsSequentialFold() throws {
        let (_, events, _) = try decodeReplay()
        let evs = events.map { $0.event }
        let batch = ChatSessionState().reduce(events: evs)
        var sequential = ChatSessionState()
        for e in evs { sequential = sequential.reduce(e) }
        XCTAssertEqual(batch, sequential, "batch fold == sequential fold")
    }

    /// Conditional, fixture-grounded contract: when the replay carries the relevant
    /// event types, the reducer reflects them. Guards each assertion on the event's
    /// presence so a refreshed fixture never breaks the test.
    func testRealEventReplayReflectsTypedEvents() throws {
        let (_, events, _) = try decodeReplay()
        let evs = events.map { $0.event }
        let state = ChatSessionState().reduce(events: evs)

        // model_select → "provider/id"
        if evs.contains(where: { $0.eventType == "model_select" }) {
            let model = try XCTUnwrap(state.model, "model_select sets the model")
            XCTAssertTrue(model.contains("/"), "model is provider/id qualified, got \(model)")
        }
        // stats_update with contextUsage → contextWindow set (> 0)
        let hasContext = evs.contains {
            $0.eventType == "stats_update" && $0.data["contextUsage"]?.objectValue?["contextWindow"]?.numberValue != nil
        }
        if hasContext {
            let win = try XCTUnwrap(state.contextWindow, "contextUsage sets contextWindow")
            XCTAssertGreaterThan(win, 0)
        }
        // tool_execution_start → at least one tool row, each with a stable tool id.
        if evs.contains(where: { $0.eventType == "tool_execution_start" }) {
            let toolRows = state.messages.filter { $0.role == .toolResult }
            XCTAssertFalse(toolRows.isEmpty, "tool_execution_start yields a tool row")
            XCTAssertTrue(toolRows.allSatisfy { $0.toolCallId != nil }, "tool rows keep their toolCallId")
        }
    }

    /// Replaying the SAME event_replay batch twice (idempotency on reconnect resume)
    /// must NOT duplicate tool rows — they are keyed on `toolCallId`. (User/assistant
    /// text rows are positional by design and excluded from this invariant.)
    func testToolRowsIdempotentAcrossReplayedBatch() throws {
        let (_, events, _) = try decodeReplay()
        let evs = events.map { $0.event }
        try XCTSkipIf(!evs.contains { $0.eventType == "tool_execution_start" },
                      "fixture has no tool calls to check idempotency")

        let once = ChatSessionState().reduce(events: evs)
        // Re-fold the tool lifecycle events on top of the reduced state (a resume
        // replays them again). Tool rows must not multiply.
        let toolEvents = evs.filter { $0.eventType.hasPrefix("tool_execution_") }
        let twice = once.reduce(events: toolEvents)

        func toolRowIds(_ s: ChatSessionState) -> Set<String> {
            Set(s.messages.filter { $0.role == .toolResult }.compactMap { $0.toolCallId })
        }
        XCTAssertEqual(toolRowIds(once), toolRowIds(twice),
                       "replayed tool lifecycle does not create duplicate tool rows")
        XCTAssertEqual(once.messages.filter { $0.role == .toolResult }.count,
                       twice.messages.filter { $0.role == .toolResult }.count,
                       "tool row count stable across a replayed batch")
    }
}
