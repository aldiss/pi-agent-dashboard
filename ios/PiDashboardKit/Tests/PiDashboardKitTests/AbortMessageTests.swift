import XCTest
@testable import PiDashboardKit

/// Abort control (parity B3a) — the app's FIRST control action. These tests pin the
/// abort MESSAGE CONSTRUCTION only, exactly as the brief requires: they never touch
/// a live session / server. They assert (1) the exact wire bytes of the abort
/// message and (2) that `DashboardClient.abort` routes through `send` (so a
/// disconnected client throws instead of silently dropping).
final class AbortMessageTests: XCTestCase {

    private func encode(_ m: ClientMessage) throws -> [String: Any] {
        let data = try JSONEncoder().encode(m)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    /// The abort message is EXACTLY `{ "type": "abort", "sessionId": <sid> }` —
    /// matching `AbortToBrowserMessage` in `packages/shared/src/browser-protocol.ts`.
    /// No extra keys (a stray field could be rejected or mis-dispatched server-side).
    func testAbortMessageExactShape() throws {
        let obj = try encode(.abort(sessionId: "sess-42"))
        XCTAssertEqual(obj["type"] as? String, "abort")
        XCTAssertEqual(obj["sessionId"] as? String, "sess-42")
        XCTAssertEqual(obj.keys.count, 2, "abort carries ONLY type + sessionId — no extra keys")
    }

    /// The sessionId is carried verbatim (not trimmed / transformed).
    func testAbortPreservesSessionIdVerbatim() throws {
        let sid = "cwd::abc-123_DEF"
        let obj = try encode(.abort(sessionId: sid))
        XCTAssertEqual(obj["sessionId"] as? String, sid)
    }

    /// `jsonString()` (the actual WS text-frame payload) is valid JSON with the
    /// abort type — the exact bytes `DashboardClient.abort` puts on the wire.
    func testAbortJSONStringIsValidWireFrame() throws {
        let json = try ClientMessage.abort(sessionId: "s").jsonString()
        let parsed = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        XCTAssertEqual(parsed["type"] as? String, "abort")
        XCTAssertEqual(parsed["sessionId"] as? String, "s")
    }

    /// `DashboardClient.abort` routes through `send`, so on a DISCONNECTED client it
    /// throws `.notConnected` — proving the convenience actually attempts the wire
    /// send (no silent no-op) WITHOUT needing a live server.
    func testAbortOnDisconnectedClientThrowsNotConnected() async {
        let client = DashboardClient()
        do {
            try await client.abort(sessionId: "s")
            XCTFail("abort on a disconnected client must throw")
        } catch let error as DashboardClientError {
            guard case .notConnected = error else {
                return XCTFail("expected .notConnected, got \(error)")
            }
        } catch {
            XCTFail("expected DashboardClientError.notConnected, got \(error)")
        }
    }
}
