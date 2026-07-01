import XCTest
@testable import PiDashboardKit

/// Cluster 2 — action-result frame decoding. The resume/spawn control actions fire
/// but their RESULT frames weren't decoded (→ silent failures, stuck spinners). These
/// tests pin the decode of `resume_result` / `spawn_result` / `spawn_error` (success
/// AND failure), faithful to `packages/shared/src/browser-protocol.ts`. Pure JSON →
/// `ServerMessage`, no socket.
final class ActionResultDecodeTests: XCTestCase {

    private func decode(_ json: String) throws -> ServerMessage {
        try JSONDecoder().decode(ServerMessage.self, from: Data(json.utf8))
    }

    // MARK: resume_result

    func testResumeResultSuccess() throws {
        let msg = try decode(#"{"type":"resume_result","sessionId":"s1","success":true,"message":"ok","requestId":"r1"}"#)
        guard case let .resumeResult(sid, success, message, requestId) = msg else {
            return XCTFail("expected .resumeResult, got \(msg.wireType)")
        }
        XCTAssertEqual(sid, "s1")
        XCTAssertTrue(success)
        XCTAssertEqual(message, "ok")
        XCTAssertEqual(requestId, "r1")
        XCTAssertEqual(msg.wireType, "resume_result")
    }

    func testResumeResultFailureCarriesMessage() throws {
        let msg = try decode(#"{"type":"resume_result","sessionId":"s1","success":false,"message":"Session is already active"}"#)
        guard case let .resumeResult(_, success, message, requestId) = msg else {
            return XCTFail("expected .resumeResult")
        }
        XCTAssertFalse(success)
        XCTAssertEqual(message, "Session is already active", "failure message decoded for surfacing")
        XCTAssertNil(requestId, "requestId optional")
    }

    /// Extra fields the native model ignores (newSessionId, code) don't break decode.
    func testResumeResultToleratesExtraFields() throws {
        let msg = try decode(#"{"type":"resume_result","sessionId":"s1","success":false,"message":"fork failed","code":"FORK_EMPTY_SESSION","newSessionId":"x"}"#)
        guard case let .resumeResult(_, success, message, _) = msg else { return XCTFail() }
        XCTAssertFalse(success)
        XCTAssertEqual(message, "fork failed")
    }

    // MARK: spawn_result

    func testSpawnResultSuccess() throws {
        let msg = try decode(#"{"type":"spawn_result","cwd":"/Users/op/proj","success":true,"message":"spawned","pid":4821,"requestId":"r9"}"#)
        guard case let .spawnResult(cwd, success, message, requestId) = msg else {
            return XCTFail("expected .spawnResult, got \(msg.wireType)")
        }
        XCTAssertEqual(cwd, "/Users/op/proj")
        XCTAssertTrue(success)
        XCTAssertEqual(message, "spawned")
        XCTAssertEqual(requestId, "r9")
    }

    func testSpawnResultFailure() throws {
        let msg = try decode(#"{"type":"spawn_result","cwd":"/x","success":false,"message":"preflight failed"}"#)
        guard case let .spawnResult(cwd, success, message, _) = msg else { return XCTFail() }
        XCTAssertEqual(cwd, "/x")
        XCTAssertFalse(success)
        XCTAssertEqual(message, "preflight failed")
    }

    // MARK: spawn_error (hard failure companion)

    func testSpawnErrorDecodesCwdMessageCode() throws {
        let msg = try decode(#"{"type":"spawn_error","cwd":"/x","strategy":"tmux","message":"pi not found","code":"PI_NOT_FOUND","stderr":"...tail...","reasons":[]}"#)
        guard case let .spawnError(cwd, message, code) = msg else {
            return XCTFail("expected .spawnError, got \(msg.wireType)")
        }
        XCTAssertEqual(cwd, "/x")
        XCTAssertEqual(message, "pi not found")
        XCTAssertEqual(code, "PI_NOT_FOUND", "structured classifier decoded")
        XCTAssertEqual(msg.wireType, "spawn_error")
    }

    func testSpawnErrorWithoutCode() throws {
        let msg = try decode(#"{"type":"spawn_error","cwd":"/x","strategy":"tmux","message":"boom"}"#)
        guard case let .spawnError(_, message, code) = msg else { return XCTFail() }
        XCTAssertEqual(message, "boom")
        XCTAssertNil(code)
    }

    // MARK: still-additive (unknown types don't break)

    func testUnknownActionFrameStillUnknown() throws {
        let msg = try decode(#"{"type":"some_future_result","cwd":"/x"}"#)
        guard case .unknown(let t) = msg else { return XCTFail("expected .unknown") }
        XCTAssertEqual(t, "some_future_result")
    }

    /// Missing `success` defaults to false (fail-safe: an ambiguous result is treated
    /// as failure so the spinner clears + an error surfaces rather than hanging).
    func testMissingSuccessDefaultsFalse() throws {
        let msg = try decode(#"{"type":"resume_result","sessionId":"s1","message":"?"}"#)
        guard case let .resumeResult(_, success, _, _) = msg else { return XCTFail() }
        XCTAssertFalse(success)
    }
}
