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
