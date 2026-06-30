import XCTest
@testable import PiDashboardKit

/// COMPLETE protocol round-trip coverage — every `ClientMessage` encodes to its
/// exact wire `type` + fields, every handled `ServerMessage` decodes, and unknown
/// / partial / defaulted envelopes are forward-compatible. The seed `ProtocolTests`
/// covers a representative subset; this file closes the gap to FULL coverage of the
/// `browser-protocol.ts` surface the native client speaks (TEST-CONTRACT §C).
///
/// New file (no collision with the seed `ProtocolTests`).
final class ProtocolRoundTripTests: XCTestCase {

    private func encode(_ m: ClientMessage) throws -> [String: Any] {
        let data = try JSONEncoder().encode(m)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func decode(_ s: String) throws -> ServerMessage {
        try JSONDecoder().decode(ServerMessage.self, from: Data(s.utf8))
    }

    // MARK: - ClientMessage: every case → exact wire type + fields

    func testEncodeEverySingleSessionIdMessage() throws {
        // The control/lifecycle messages that carry only `{ type, sessionId }`.
        let cases: [(ClientMessage, String)] = [
            (.unsubscribe(sessionId: "s"), "unsubscribe"),
            (.abort(sessionId: "s"), "abort"),
            (.sessionView(sessionId: "s"), "session_view"),
            (.sessionUnview(sessionId: "s"), "session_unview"),
            (.requestModels(sessionId: "s"), "request_models"),
            (.hideSession(sessionId: "s"), "hide_session"),
            (.unhideSession(sessionId: "s"), "unhide_session"),
            (.shutdown(sessionId: "s"), "shutdown"),
            (.forceKill(sessionId: "s"), "force_kill"),
        ]
        for (msg, wire) in cases {
            let obj = try encode(msg)
            XCTAssertEqual(obj["type"] as? String, wire, "\(wire) wire type")
            XCTAssertEqual(obj["sessionId"] as? String, "s", "\(wire) carries sessionId")
            XCTAssertEqual(obj.keys.count, 2, "\(wire) carries exactly type+sessionId")
        }
    }

    func testEncodeSubscribeOmitsNilLastSeqButKeepsZero() throws {
        // lastSeq is optional: absent when nil, present (even when 0) otherwise.
        XCTAssertNil(try encode(.subscribe(sessionId: "s", lastSeq: nil))["lastSeq"])
        XCTAssertEqual(try encode(.subscribe(sessionId: "s", lastSeq: 0))["lastSeq"] as? Int, 0)
        XCTAssertEqual(try encode(.subscribe(sessionId: "s", lastSeq: 99))["lastSeq"] as? Int, 99)
    }

    func testEncodeSendPromptFieldMatrix() throws {
        // text-only
        let textOnly = try encode(.sendPrompt(sessionId: "s", text: "hi", images: nil, queueNonce: nil))
        XCTAssertEqual(textOnly["type"] as? String, "send_prompt")
        XCTAssertEqual(textOnly["text"] as? String, "hi")
        XCTAssertNil(textOnly["images"])
        XCTAssertNil(textOnly["queueNonce"])

        // text + nonce + multi-image (order + fields preserved)
        let full = try encode(.sendPrompt(
            sessionId: "s", text: "look",
            images: [ImageContent(data: "AAAA", mimeType: "image/png"),
                     ImageContent(data: "BBBB", mimeType: "image/jpeg")],
            queueNonce: "n9"))
        XCTAssertEqual(full["queueNonce"] as? String, "n9")
        let imgs = try XCTUnwrap(full["images"] as? [[String: Any]])
        XCTAssertEqual(imgs.count, 2)
        XCTAssertEqual(imgs[0]["type"] as? String, "image")
        XCTAssertEqual(imgs[0]["data"] as? String, "AAAA")
        XCTAssertEqual(imgs[1]["mimeType"] as? String, "image/jpeg")
    }

    func testEncodeSetThinkingLevelAndRename() throws {
        let lvl = try encode(.setThinkingLevel(sessionId: "s", level: "high"))
        XCTAssertEqual(lvl["type"] as? String, "set_thinking_level")
        XCTAssertEqual(lvl["level"] as? String, "high")

        let rn = try encode(.renameSession(sessionId: "s", name: "My Session"))
        XCTAssertEqual(rn["type"] as? String, "rename_session")
        XCTAssertEqual(rn["name"] as? String, "My Session")
    }

    func testEncodeResumeSessionOptionalRequestId() throws {
        let withId = try encode(.resumeSession(sessionId: "s", mode: "continue", requestId: "r1"))
        XCTAssertEqual(withId["type"] as? String, "resume_session")
        XCTAssertEqual(withId["mode"] as? String, "continue")
        XCTAssertEqual(withId["requestId"] as? String, "r1")

        let noId = try encode(.resumeSession(sessionId: "s", mode: "fork", requestId: nil))
        XCTAssertNil(noId["requestId"], "nil requestId omitted")
    }

    /// `jsonString()` produces valid, decodable UTF-8 JSON (the actual WS text frame).
    func testClientMessageJSONStringIsValidWire() throws {
        let json = try ClientMessage.sendPrompt(sessionId: "s", text: "café ☕️", images: nil, queueNonce: nil).jsonString()
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        XCTAssertEqual(obj["text"] as? String, "café ☕️", "unicode survives the wire frame")
    }

    // MARK: - ServerMessage: the decode cases the seed omits

    func testDecodeSessionAddedWithSpawnRequestId() throws {
        let m = try decode(#"{"type":"session_added","session":{"id":"x","status":"active"},"spawnRequestId":"sr1"}"#)
        guard case .sessionAdded(let session, let spawn) = m else { return XCTFail("expected session_added, got \(m.wireType)") }
        XCTAssertEqual(session.id, "x")
        XCTAssertEqual(session.status, "active")
        XCTAssertEqual(spawn, "sr1")
    }

    func testDecodeSessionAddedWithoutSpawnRequestId() throws {
        let m = try decode(#"{"type":"session_added","session":{"id":"x"}}"#)
        guard case .sessionAdded(_, let spawn) = m else { return XCTFail("expected session_added") }
        XCTAssertNil(spawn, "optional spawnRequestId absent")
    }

    func testDecodeSessionRemoved() throws {
        let m = try decode(#"{"type":"session_removed","sessionId":"gone"}"#)
        guard case .sessionRemoved(let sid) = m else { return XCTFail("expected session_removed") }
        XCTAssertEqual(sid, "gone")
    }

    func testDecodeSessionsReordered() throws {
        let m = try decode(#"{"type":"sessions_reordered","cwd":"/x","sessionIds":["b","a","c"]}"#)
        guard case .sessionsReordered(let cwd, let ids) = m else { return XCTFail("expected sessions_reordered") }
        XCTAssertEqual(cwd, "/x")
        XCTAssertEqual(ids, ["b", "a", "c"])
    }

    func testDecodePinnedDirsUpdated() throws {
        let m = try decode(#"{"type":"pinned_dirs_updated","paths":["/x","/y"]}"#)
        guard case .pinnedDirsUpdated(let paths) = m else { return XCTFail("expected pinned_dirs_updated") }
        XCTAssertEqual(paths, ["/x", "/y"])
    }

    func testDecodeSessionStateReset() throws {
        let m = try decode(#"{"type":"session_state_reset","sessionId":"s"}"#)
        guard case .sessionStateReset(let sid) = m else { return XCTFail("expected session_state_reset") }
        XCTAssertEqual(sid, "s")
    }

    func testDecodeModelsList() throws {
        let m = try decode(#"{"type":"models_list","sessionId":"s","models":[{"provider":"anthropic","id":"claude-opus"},{"provider":"openai","id":"gpt-5"}]}"#)
        guard case .modelsList(let sid, let models) = m else { return XCTFail("expected models_list") }
        XCTAssertEqual(sid, "s")
        XCTAssertEqual(models.map { $0.qualified }, ["anthropic/claude-opus", "openai/gpt-5"])
    }

    func testDecodeLiveEventFrame() throws {
        let m = try decode(#"{"type":"event","sessionId":"s","seq":12,"event":{"eventType":"agent_start","timestamp":99,"data":{}}}"#)
        guard case .event(let sid, let seq, let event) = m else { return XCTFail("expected event") }
        XCTAssertEqual(sid, "s"); XCTAssertEqual(seq, 12)
        XCTAssertEqual(event.eventType, "agent_start")
    }

    // MARK: - Forward-compat + defaulting

    func testUnknownTypePreservesWireType() throws {
        let m = try decode(#"{"type":"flow_panel_update","flowId":"f1","payload":{"deep":[1,2,3]}}"#)
        guard case .unknown(let t) = m else { return XCTFail("expected unknown") }
        XCTAssertEqual(t, "flow_panel_update")
        XCTAssertEqual(m.wireType, "flow_panel_update", "unknown surfaces its wire type for routing/logging")
    }

    func testSnapshotDefaultsMissingArraysAndMaps() throws {
        // A snapshot missing `sessions`/`orders` must default to empties, not throw.
        let m = try decode(#"{"type":"sessions_snapshot"}"#)
        guard case .sessionsSnapshot(let sessions, let orders) = m else { return XCTFail("expected snapshot") }
        XCTAssertTrue(sessions.isEmpty)
        XCTAssertTrue(orders.isEmpty)
    }

    func testEventReplayDefaultsIsLastTrueWhenAbsent() throws {
        // isLast absent → treated as a terminal batch (true), matching the decoder default.
        let m = try decode(#"{"type":"event_replay","sessionId":"s","events":[]}"#)
        guard case .eventReplay(_, let events, let isLast) = m else { return XCTFail("expected event_replay") }
        XCTAssertTrue(events.isEmpty)
        XCTAssertTrue(isLast, "absent isLast defaults to true")
    }

    func testSendPromptFailedOptionalFields() throws {
        // reason + queueNonce are both optional.
        let m = try decode(#"{"type":"send_prompt_failed","sessionId":"s"}"#)
        guard case .sendPromptFailed(let sid, let nonce, let reason) = m else { return XCTFail("expected send_prompt_failed") }
        XCTAssertEqual(sid, "s")
        XCTAssertNil(nonce)
        XCTAssertNil(reason)
    }

    /// An unknown enum value on a known field stays a raw string (forward-compatible
    /// with statuses/sources the server may add) — `statusEnum` is nil, raw preserved.
    func testUnknownStatusStaysRawString() throws {
        let m = try decode(#"{"type":"session_added","session":{"id":"x","status":"quantum-superposition","source":"holodeck"}}"#)
        guard case .sessionAdded(let session, _) = m else { return XCTFail("expected session_added") }
        XCTAssertEqual(session.status, "quantum-superposition", "raw status preserved")
        XCTAssertNil(session.statusEnum, "unknown status → nil typed enum (no throw)")
        XCTAssertEqual(session.source, "holodeck")
        XCTAssertNil(session.sourceEnum)
    }

    // MARK: - websocketURL mapping (extends the seed's two cases)

    func testWebsocketURLMappingMatrix() {
        func ws(_ s: String) -> String? { DashboardClient.websocketURL(base: URL(string: s)!)?.absoluteString }
        XCTAssertEqual(ws("http://localhost:8000"), "ws://localhost:8000/ws")
        XCTAssertEqual(ws("https://x.ts.net:8443"), "wss://x.ts.net:8443/ws")
        // already a ws/wss base — scheme preserved, /ws appended once.
        XCTAssertEqual(ws("ws://h:1"), "ws://h:1/ws")
        XCTAssertEqual(ws("wss://h:1"), "wss://h:1/ws")
        // trailing slash collapses (no double //ws).
        XCTAssertEqual(ws("http://h:2/"), "ws://h:2/ws")
        // an already-/ws path is not doubled.
        XCTAssertEqual(ws("http://h:3/ws"), "ws://h:3/ws")
        // unknown scheme falls back to ws.
        XCTAssertEqual(ws("foo://h:4"), "ws://h:4/ws")
    }
}
