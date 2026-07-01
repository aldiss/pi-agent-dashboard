import XCTest
@testable import PiDashboardKit

/// Spawn control (parity B3c) — the app's THIRD + final B3 control action (abort +
/// resume shipped). Spawn is a DISTINCT browser-protocol message (`spawn_session`)
/// keyed by `cwd` (NOT sessionId) — the server starts a fresh pi in that directory
/// with its default strategy. These tests pin MESSAGE + FLOW + dir-list
/// construction only; they never touch a live session/server.
final class SpawnMessageTests: XCTestCase {

    private func encode(_ m: ClientMessage) throws -> [String: Any] {
        let data = try JSONEncoder().encode(m)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    // MARK: message shape (SpawnSessionBrowserMessage)

    /// Spawn encodes to `{ type:"spawn_session", cwd }` — the shape from
    /// `packages/shared/src/browser-protocol.ts`. Only `cwd` is required; `requestId`
    /// omitted when nil, and there is NO `sessionId` (spawn is keyed by directory).
    func testSpawnMessageShapeCwdOnly() throws {
        let obj = try encode(.spawnSession(cwd: "/Users/op/proj", requestId: nil))
        XCTAssertEqual(obj["type"] as? String, "spawn_session")
        XCTAssertEqual(obj["cwd"] as? String, "/Users/op/proj")
        XCTAssertNil(obj["requestId"], "requestId omitted when nil")
        XCTAssertNil(obj["sessionId"], "spawn is keyed by cwd — no sessionId")
        XCTAssertEqual(obj.keys.count, 2, "only type + cwd")
    }

    /// `requestId` is included when provided (correlates `spawn_result` +
    /// the eventual `session_added.spawnRequestId`).
    func testSpawnCarriesRequestIdWhenPresent() throws {
        let obj = try encode(.spawnSession(cwd: "/x", requestId: "req-9"))
        XCTAssertEqual(obj["requestId"] as? String, "req-9")
        XCTAssertEqual(obj["cwd"] as? String, "/x")
    }

    /// `jsonString()` — the actual WS text frame — is valid JSON with the spawn type.
    func testSpawnJSONStringIsValidWireFrame() throws {
        let json = try ClientMessage.spawnSession(cwd: "/w", requestId: nil).jsonString()
        let parsed = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        XCTAssertEqual(parsed["type"] as? String, "spawn_session")
        XCTAssertEqual(parsed["cwd"] as? String, "/w")
    }

    // MARK: client flow (no live server)

    /// `DashboardClient.spawn` routes through `send`, so on a DISCONNECTED client it
    /// throws `.notConnected` — proving the convenience attempts the wire send
    /// WITHOUT a live server.
    func testSpawnOnDisconnectedClientThrowsNotConnected() async {
        let client = DashboardClient()
        do {
            try await client.spawn(cwd: "/x")
            XCTFail("spawn on a disconnected client must throw")
        } catch let error as DashboardClientError {
            guard case .notConnected = error else {
                return XCTFail("expected .notConnected, got \(error)")
            }
        } catch {
            XCTFail("expected DashboardClientError.notConnected, got \(error)")
        }
    }

    // MARK: known-directories picker source

    private func session(_ id: String, cwd: String?, groupCwd: String? = nil) -> DashboardSession {
        DashboardSession(id: id, cwd: cwd, groupCwd: groupCwd)
    }

    /// The picker list = distinct session group-paths ∪ pinned dirs, deduped by
    /// canonical path key, sorted by basename. Worktree sessions fold to `groupCwd`.
    func testKnownDirectoriesDedupAndSort() {
        let sessions = [
            session("a", cwd: "/Users/op/zebra"),
            session("b", cwd: "/Users/op/alpha"),
            session("c", cwd: "/Users/op/alpha"),                    // dup by cwd
            session("d", cwd: "/wt/x", groupCwd: "/Users/op/alpha"), // worktree → folds to alpha
            session("e", cwd: "/Users/op/zebra/"),                    // trailing-slash dup of zebra
        ]
        let dirs = SessionGrouping.knownDirectories(sessions: sessions, pinned: ["/Users/op/mango"])
        // alpha, mango, zebra — one of each, basename-sorted.
        XCTAssertEqual(dirs, ["/Users/op/alpha", "/Users/op/mango", "/Users/op/zebra"])
    }

    /// Pinned dirs with no sessions still appear (you can spawn into an empty pinned
    /// dir); empty/blank paths are dropped.
    func testKnownDirectoriesIncludesEmptyPinnedAndDropsBlank() {
        let sessions = [session("a", cwd: ""), session("b", cwd: "/Users/op/proj")]
        let dirs = SessionGrouping.knownDirectories(sessions: sessions, pinned: ["/Users/op/empty-pin"])
        XCTAssertEqual(dirs, ["/Users/op/empty-pin", "/Users/op/proj"])
    }
}
