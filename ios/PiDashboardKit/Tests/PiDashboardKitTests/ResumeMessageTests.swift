import XCTest
@testable import PiDashboardKit

/// Resume control (parity B3b) — the app's SECOND control action (after abort).
/// Resume is a DISTINCT browser-protocol message (`resume_session`), not a
/// prompt-to-an-ended-session; the server sets the session `resuming: true` and
/// broadcasts a `session_updated` delta. These tests pin MESSAGE + FLOW
/// construction only — they never touch a live session/server.
final class ResumeMessageTests: XCTestCase {

    private func encode(_ m: ClientMessage) throws -> [String: Any] {
        let data = try JSONEncoder().encode(m)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    // MARK: message shape (ResumeSessionBrowserMessage)

    /// `continue` resume encodes to `{ type:"resume_session", sessionId, mode }` —
    /// the shape from `packages/shared/src/browser-protocol.ts`. `requestId` /
    /// `placement` are omitted (server defaults placement to "front").
    func testResumeContinueMessageShape() throws {
        let obj = try encode(.resumeSession(sessionId: "sess-7", mode: "continue", requestId: nil))
        XCTAssertEqual(obj["type"] as? String, "resume_session")
        XCTAssertEqual(obj["sessionId"] as? String, "sess-7")
        XCTAssertEqual(obj["mode"] as? String, "continue")
        XCTAssertNil(obj["requestId"], "requestId omitted when nil")
        XCTAssertNil(obj["placement"], "placement omitted → server default 'front'")
        XCTAssertEqual(obj.keys.count, 3, "only type + sessionId + mode")
    }

    /// `requestId` is included when provided (correlates the `resume_result`).
    func testResumeCarriesRequestIdWhenPresent() throws {
        let obj = try encode(.resumeSession(sessionId: "s", mode: "continue", requestId: "req-1"))
        XCTAssertEqual(obj["requestId"] as? String, "req-1")
    }

    /// The `mode` is carried verbatim — `fork` still encodes (the wire supports it),
    /// even though the B3b UI only drives `continue`.
    func testResumeModeCarriedVerbatim() throws {
        XCTAssertEqual(try encode(.resumeSession(sessionId: "s", mode: "fork", requestId: nil))["mode"] as? String, "fork")
    }

    /// `jsonString()` — the actual WS text frame — is valid JSON with the resume type.
    func testResumeJSONStringIsValidWireFrame() throws {
        let json = try ClientMessage.resumeSession(sessionId: "s", mode: "continue", requestId: nil).jsonString()
        let parsed = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        XCTAssertEqual(parsed["type"] as? String, "resume_session")
        XCTAssertEqual(parsed["mode"] as? String, "continue")
    }

    // MARK: client flow (no live server)

    /// `DashboardClient.resume` routes through `send`, so on a DISCONNECTED client it
    /// throws `.notConnected` — proving the convenience attempts the wire send
    /// WITHOUT a live server. Also verifies `mode` defaults to `continue`.
    func testResumeOnDisconnectedClientThrowsNotConnected() async {
        let client = DashboardClient()
        do {
            try await client.resume(sessionId: "s")  // default mode: continue
            XCTFail("resume on a disconnected client must throw")
        } catch let error as DashboardClientError {
            guard case .notConnected = error else {
                return XCTFail("expected .notConnected, got \(error)")
            }
        } catch {
            XCTFail("expected DashboardClientError.notConnected, got \(error)")
        }
    }

    // MARK: resuming state (server-truth decode + patch merge)

    /// The server drives the resume state via a `resuming` field on the session; the
    /// native model must decode it (it was PWA-only before B3b).
    func testResumingDecodesFromSessionJSON() throws {
        let json = #"{"id":"s","status":"ended","resuming":true}"#.data(using: .utf8)!
        let s = try JSONDecoder().decode(DashboardSession.self, from: json)
        XCTAssertEqual(s.resuming, true)
    }

    /// A `session_updated{resuming:true}` delta MERGES onto the session — the
    /// server-truth source for the "Resuming…" state.
    func testResumingPatchMergesLive() throws {
        var s = DashboardSession(id: "s", status: "ended")
        XCTAssertNil(s.resuming)
        let onJSON = #"{"resuming":true}"#.data(using: .utf8)!
        try JSONDecoder().decode(SessionPatch.self, from: onJSON).apply(to: &s)
        XCTAssertEqual(s.resuming, true)
        // …and cleared when the server settles it (failure/timeout or re-registered).
        let offJSON = #"{"resuming":false}"#.data(using: .utf8)!
        try JSONDecoder().decode(SessionPatch.self, from: offJSON).apply(to: &s)
        XCTAssertEqual(s.resuming, false)
    }
}
