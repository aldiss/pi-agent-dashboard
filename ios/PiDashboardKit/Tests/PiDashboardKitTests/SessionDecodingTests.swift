import XCTest
@testable import PiDashboardKit

/// Contract tests: decode REAL payloads captured from the live dashboard
/// (`/api/sessions`, `/api/health`) into the Codable models. These assert the
/// Swift wire contract matches the server's actual byte-shapes — the foundation
/// of the native client's correctness.
final class SessionDecodingTests: XCTestCase {

    private func fixtureData(_ name: String, _ ext: String) throws -> Data {
        let urls = [
            Bundle.module.url(forResource: name, withExtension: ext, subdirectory: "Fixtures"),
            Bundle.module.url(forResource: name, withExtension: ext),
        ].compactMap { $0 }
        let url = try XCTUnwrap(urls.first, "fixture \(name).\(ext) not found in test bundle")
        return try Data(contentsOf: url)
    }

    func testDecodeRealSessionsPayload() throws {
        let data = try fixtureData("sessions-sample", "json")
        let resp = try JSONDecoder().decode(ApiResponse<[DashboardSession]>.self, from: data)
        let sessions = try XCTUnwrap(resp.data)
        XCTAssertEqual(sessions.count, 8, "curated real fixture has 8 sessions")

        // Every session has an id and decodes without throwing (proven by reaching here).
        XCTAssertTrue(sessions.allSatisfy { !$0.id.isEmpty })

        // Spot-check a known real session's fields round-trip.
        let scratch = try XCTUnwrap(sessions.first { $0.name == "Scratch" })
        XCTAssertEqual(scratch.source, "tmux")
        XCTAssertEqual(scratch.status, "active")
        XCTAssertEqual(scratch.sourceEnum, .tmux)
        XCTAssertEqual(scratch.statusEnum, .active)
        XCTAssertNotNil(scratch.contextWindow)
        XCTAssertNotNil(scratch.contextFraction)
        XCTAssertNotNil(scratch.processMetrics?.loadAvg1m)

        // A claude-code source session decodes its hyphenated enum.
        if let cc = sessions.first(where: { $0.source == "claude-code" }) {
            XCTAssertEqual(cc.sourceEnum, .claudeCode)
        }
    }

    func testDecodeHealth() throws {
        let data = try fixtureData("health", "json")
        let health = try JSONDecoder().decode(HealthStatus.self, from: data)
        XCTAssertTrue(health.ok)
        XCTAssertNotNil(health.server?.activeSessions)
    }

    /// End-to-end contract proof: decode a REAL `sessions_snapshot` captured live
    /// from the dashboard browser gateway (`ws://localhost:8000/ws`) through the
    /// full `ServerMessage` decoder — the actual server bytes the native client
    /// will receive on connect.
    func testDecodeRealWebSocketSnapshot() throws {
        let data = try fixtureData("ws-snapshot-sample", "json")
        let msg = try JSONDecoder().decode(ServerMessage.self, from: data)
        guard case .sessionsSnapshot(let sessions, let orders) = msg else {
            return XCTFail("expected sessions_snapshot, got \(msg.wireType)")
        }
        XCTAssertEqual(sessions.count, 8)
        XCTAssertTrue(sessions.allSatisfy { !$0.id.isEmpty })
        XCTAssertFalse(orders.isEmpty, "real snapshot carries per-cwd ordering")
        // Every ordered id refers to a session present in the snapshot.
        let ids = Set(sessions.map { $0.id })
        for (_, ordered) in orders { XCTAssertTrue(ordered.allSatisfy { ids.contains($0) }) }
        // The snapshot is groupable into tiers without error.
        let tiers = SessionGrouping.groupByTier(sessions)
        XCTAssertFalse(tiers.isEmpty)
    }

    func testPartialUpdatePatchDecodes() throws {
        // session_updated.updates is a Partial<DashboardSession> — a bare patch
        // with only an id must decode against the same model.
        let patch = #"{"id":"abc","status":"streaming","currentTool":"bash"}"#.data(using: .utf8)!
        let s = try JSONDecoder().decode(DashboardSession.self, from: patch)
        XCTAssertEqual(s.id, "abc")
        XCTAssertEqual(s.status, "streaming")
        XCTAssertEqual(s.currentTool, "bash")
        XCTAssertNil(s.name)
    }
}
