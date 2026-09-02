import XCTest
@testable import PiDashboardKit

/// Encode/decode tests for the WS protocol envelopes — asserts the native client
/// produces the exact `BrowserToServerMessage` shapes the server expects and
/// decodes `ServerToBrowserMessage` shapes (including forward-compatible unknown
/// types) faithfully.
final class ProtocolTests: XCTestCase {

    private func encodeObject(_ m: ClientMessage) throws -> [String: Any] {
        let data = try JSONEncoder().encode(m)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func decode(_ s: String) throws -> ServerMessage {
        try JSONDecoder().decode(ServerMessage.self, from: Data(s.utf8))
    }

    func testEncodeClientMessages() throws {
        let sub = try encodeObject(.subscribe(sessionId: "s1", lastSeq: 42))
        XCTAssertEqual(sub["type"] as? String, "subscribe")
        XCTAssertEqual(sub["sessionId"] as? String, "s1")
        XCTAssertEqual(sub["lastSeq"] as? Int, 42)

        let subNoSeq = try encodeObject(.subscribe(sessionId: "s1", lastSeq: nil))
        XCTAssertNil(subNoSeq["lastSeq"])

        let sp = try encodeObject(.sendPrompt(sessionId: "s1", text: "hi there", images: nil, queueNonce: "n1"))
        XCTAssertEqual(sp["type"] as? String, "send_prompt")
        XCTAssertEqual(sp["text"] as? String, "hi there")
        XCTAssertEqual(sp["queueNonce"] as? String, "n1")
        XCTAssertNil(sp["images"])

        let spImg = try encodeObject(.sendPrompt(sessionId: "s1", text: "", images: [ImageContent(data: "AAAA", mimeType: "image/png")], queueNonce: nil))
        let imgs = try XCTUnwrap(spImg["images"] as? [[String: Any]])
        XCTAssertEqual(imgs.first?["type"] as? String, "image")
        XCTAssertEqual(imgs.first?["mimeType"] as? String, "image/png")

        XCTAssertEqual(try encodeObject(.sessionView(sessionId: "s1"))["type"] as? String, "session_view")
        XCTAssertEqual(try encodeObject(.abort(sessionId: "s1"))["type"] as? String, "abort")

        let setModel = try encodeObject(.setModel(sessionId: "s1", provider: "anthropic", modelId: "claude-opus"))
        XCTAssertEqual(setModel["type"] as? String, "set_model")
        XCTAssertEqual(setModel["provider"] as? String, "anthropic")
        XCTAssertEqual(setModel["modelId"] as? String, "claude-opus")

        let resume = try encodeObject(.resumeSession(sessionId: "s1", mode: "fork", requestId: "r1"))
        XCTAssertEqual(resume["type"] as? String, "resume_session")
        XCTAssertEqual(resume["mode"] as? String, "fork")
        XCTAssertEqual(resume["requestId"] as? String, "r1")
    }

    func testDecodeSessionsSnapshot() throws {
        let snap = try decode(#"{"type":"sessions_snapshot","sessions":[{"id":"a","status":"active"}],"orders":{"/x":["a"]}}"#)
        guard case .sessionsSnapshot(let sessions, let orders) = snap else { return XCTFail("expected snapshot, got \(snap.wireType)") }
        XCTAssertEqual(sessions.map { $0.id }, ["a"])
        XCTAssertEqual(orders["/x"], ["a"])
    }

    func testDecodeSessionUpdatedAppliesPatch() throws {
        let upd = try decode(#"{"type":"session_updated","sessionId":"a","updates":{"status":"streaming","currentTool":"bash","contextTokens":1000}}"#)
        guard case .sessionUpdated(let sid, let patch) = upd else { return XCTFail("expected session_updated") }
        XCTAssertEqual(sid, "a")
        XCTAssertEqual(patch.status, "streaming")
        var base = DashboardSession(id: "a", status: "active")
        patch.apply(to: &base)
        XCTAssertEqual(base.status, "streaming")
        XCTAssertEqual(base.currentTool, "bash")
        XCTAssertEqual(base.contextTokens, 1000)
        XCTAssertNil(base.name) // patch left absent fields untouched
    }

    func testLiveSessionUpdateClearsReconnectBannerWithoutResettingBackoff() {
        var state = ConnectionFrameState(
            phase: .reconnecting, hasEnteredDashboard: true, reconnectAttempt: 4)

        state.receive(.sessionUpdated(sessionId: "a", updates: SessionPatch()))

        XCTAssertEqual(state.phase, .connected, "live traffic proves the transport is up")
        XCTAssertTrue(state.hasEnteredDashboard)
        XCTAssertEqual(state.reconnectAttempt, 4, "ordinary traffic must not reset reconnect backoff")
    }

    func testLiveSessionUpdateDoesNotSatisfyInitialReadyGate() {
        var state = ConnectionFrameState(
            phase: .reconnecting, hasEnteredDashboard: false, reconnectAttempt: 4)

        state.receive(.sessionUpdated(sessionId: "a", updates: SessionPatch()))

        XCTAssertEqual(state.phase, .connected)
        XCTAssertFalse(state.hasEnteredDashboard, "a delta cannot replace the initial snapshot")
        XCTAssertEqual(state.reconnectAttempt, 4)
    }

    func testSnapshotSatisfiesReadyGateAndResetsBackoff() {
        var state = ConnectionFrameState(
            phase: .reconnecting, hasEnteredDashboard: false, reconnectAttempt: 4)

        state.receive(.sessionsSnapshot(sessions: [], orders: [:]))

        XCTAssertEqual(state.phase, .connected)
        XCTAssertTrue(state.hasEnteredDashboard)
        XCTAssertEqual(state.reconnectAttempt, 0, "only a real snapshot resets reconnect backoff")
    }

    func testDecodeEventAndReplay() throws {
        let ev = try decode(#"{"type":"event","sessionId":"a","seq":7,"event":{"eventType":"turn_end","timestamp":123.0,"data":{"cost":0.1,"label":"done"}}}"#)
        guard case .event(let s, let seq, let event) = ev else { return XCTFail("expected event") }
        XCTAssertEqual(s, "a"); XCTAssertEqual(seq, 7)
        XCTAssertEqual(event.eventType, "turn_end")
        XCTAssertEqual(event.data["cost"]?.numberValue, 0.1)
        XCTAssertEqual(event.data["label"]?.stringValue, "done")

        let replay = try decode(#"{"type":"event_replay","sessionId":"a","events":[{"seq":1,"event":{"eventType":"message_update","timestamp":1,"data":{}}}],"isLast":false}"#)
        guard case .eventReplay(_, let events, let isLast) = replay else { return XCTFail("expected replay") }
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events.first?.seq, 1)
        XCTAssertFalse(isLast)
    }

    func testDecodeSendPromptFailedAndUnknown() throws {
        let fail = try decode(#"{"type":"send_prompt_failed","sessionId":"a","queueNonce":"n1","reason":"no bridge connection"}"#)
        guard case .sendPromptFailed(_, let nonce, let reason) = fail else { return XCTFail("expected fail") }
        XCTAssertEqual(nonce, "n1")
        XCTAssertEqual(reason, "no bridge connection")

        // Forward-compat: an unhandled type decodes to .unknown, never throws.
        let unk = try decode(#"{"type":"some_future_message","foo":1}"#)
        guard case .unknown(let t) = unk else { return XCTFail("expected unknown") }
        XCTAssertEqual(t, "some_future_message")
    }

    func testWebsocketURLScheme() {
        XCTAssertEqual(DashboardClient.websocketURL(base: URL(string: "http://localhost:8000")!)?.absoluteString, "ws://localhost:8000/ws")
        XCTAssertEqual(DashboardClient.websocketURL(base: URL(string: "https://x.ts.net:8443")!)?.absoluteString, "wss://x.ts.net:8443/ws")
    }
}
