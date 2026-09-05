import Foundation
import XCTest
@testable import PiDashboardKit

final class ExternalTranscriptDecodingTests: XCTestCase {
    func testDecodesWellFormedTranscript() throws {
        let json = #"""
        {
          "id": "codex:cx-gap2",
          "source": "codex",
          "entries": [
            {
              "id": "entry-1",
              "ts": 1788537600123,
              "kind": "tool_call",
              "text": "Inspect the checkout",
              "toolName": "bash",
              "toolInput": {
                "command": "git status --short",
                "flags": [true, 3, null]
              },
              "toolResult": "clean",
              "toolCallId": "call-1",
              "isError": false,
              "durationMs": 42.5
            }
          ],
          "truncated": false,
          "transcriptPath": "/tmp/cx-gap2.jsonl"
        }
        """#.data(using: .utf8)!

        let transcript = try JSONDecoder().decode(ExternalTranscriptResponse.self, from: json)
        let entry = try XCTUnwrap(transcript.entries.first)

        XCTAssertEqual(transcript.id, "codex:cx-gap2")
        XCTAssertEqual(transcript.source, "codex")
        XCTAssertFalse(transcript.truncated)
        XCTAssertEqual(transcript.transcriptPath, "/tmp/cx-gap2.jsonl")
        XCTAssertEqual(entry.id, "entry-1")
        XCTAssertEqual(entry.ts, 1_788_537_600_123)
        XCTAssertEqual(entry.timestamp, 1_788_537_600_123)
        XCTAssertEqual(entry.kind, .toolCall)
        XCTAssertEqual(entry.text, "Inspect the checkout")
        XCTAssertEqual(entry.toolName, "bash")
        XCTAssertEqual(entry.toolInput, .object([
            "command": .string("git status --short"),
            "flags": .array([.bool(true), .number(3), .null]),
        ]))
        XCTAssertEqual(entry.toolResult, "clean")
        XCTAssertEqual(entry.toolCallId, "call-1")
        XCTAssertEqual(entry.isError, false)
        XCTAssertEqual(entry.durationMs, 42.5)
    }

    func testUnknownKindFallsBackWithoutFailingTranscriptDecode() throws {
        let transcript = try decode(#"""
        {
          "id": "claude-code:cc-next",
          "source": "claude-code",
          "entries": [{"id":"future-1","ts":123,"kind":"artifact_preview","text":"preview"}],
          "truncated": false
        }
        """#)

        XCTAssertEqual(transcript.entries.first?.kind, .unknown)
    }

    func testZeroTimestampRepresentsNoTimestamp() throws {
        let transcript = try decode(#"""
        {
          "id": "codex:cx-no-time",
          "source": "codex",
          "entries": [{"id":"entry-0","ts":0,"kind":"assistant","text":"No source time"}],
          "truncated": false
        }
        """#)

        let entry = try XCTUnwrap(transcript.entries.first)
        XCTAssertEqual(entry.ts, 0)
        XCTAssertNil(entry.timestamp)
    }

    func testMissingOptionalEntryFieldsDecodeAsNil() throws {
        let transcript = try decode(#"""
        {
          "id": "codex:cx-minimal",
          "source": "codex",
          "entries": [{"id":"entry-minimal","ts":1,"kind":"user"}],
          "truncated": false
        }
        """#)

        let entry = try XCTUnwrap(transcript.entries.first)
        XCTAssertNil(entry.text)
        XCTAssertNil(entry.toolName)
        XCTAssertNil(entry.toolInput)
        XCTAssertNil(entry.toolResult)
        XCTAssertNil(entry.toolCallId)
        XCTAssertNil(entry.isError)
        XCTAssertNil(entry.durationMs)
        XCTAssertNil(transcript.transcriptPath)
    }

    func testTruncatedFlagIsPreserved() throws {
        let transcript = try decode(#"""
        {"id":"codex:cx-long","source":"codex","entries":[],"truncated":true}
        """#)

        XCTAssertTrue(transcript.truncated)
    }

    func testCaptureFallbackShapeDecodesAsEmptyTranscript() throws {
        let transcript = try decode(#"""
        {"id":"codex:cx-fallback","source":"capture","entries":[],"truncated":false}
        """#)

        XCTAssertEqual(transcript.id, "codex:cx-fallback")
        XCTAssertEqual(transcript.source, "capture")
        XCTAssertEqual(transcript.entries, [])
        XCTAssertFalse(transcript.truncated)
    }

    func testMapsTranscriptKindsOntoExistingChatRows() throws {
        let transcript = try decode(#"""
        {
          "id": "codex:cx-map",
          "source": "codex",
          "entries": [
            {"id":"u","ts":1,"kind":"user","text":"Question"},
            {"id":"a","ts":2,"kind":"assistant","text":"Answer"},
            {"id":"t","ts":3,"kind":"thinking","text":"Reasoning"},
            {"id":"call","ts":4,"kind":"tool_call","toolName":"bash","toolInput":{"command":"pwd"},"toolCallId":"tc-1"},
            {"id":"result","ts":9,"kind":"tool_result","toolResult":"/tmp","toolCallId":"tc-1","durationMs":5},
            {"id":"status","ts":10,"kind":"status","text":"Compacted"},
            {"id":"future","ts":11,"kind":"future_kind","text":"Future payload"}
          ],
          "truncated": false
        }
        """#)

        let rows = ExternalTranscriptMapper.rows(from: transcript.entries)

        XCTAssertEqual(rows.count, 6, "matching tool call/result entries share the existing tool row")
        guard case .message(let user) = rows[0],
              case .message(let assistant) = rows[1],
              case .message(let thinking) = rows[2],
              case .message(let tool) = rows[3],
              case .status(let status) = rows[4],
              case .message(let unknown) = rows[5] else {
            return XCTFail("unexpected transcript row mapping")
        }
        XCTAssertEqual(user.role, .user)
        XCTAssertEqual(assistant.role, .assistant)
        XCTAssertEqual(thinking.role, .thinking)
        XCTAssertEqual(tool.role, .toolResult)
        XCTAssertEqual(tool.toolName, "bash")
        XCTAssertEqual(tool.args, ["command": .string("pwd")])
        XCTAssertEqual(tool.toolStatus, .complete)
        XCTAssertEqual(tool.result, "/tmp")
        XCTAssertEqual(tool.duration, 5)
        XCTAssertEqual(status.text, "Compacted")
        XCTAssertEqual(unknown.role, .rawEvent)
    }

    private func decode(_ json: String) throws -> ExternalTranscriptResponse {
        try JSONDecoder().decode(ExternalTranscriptResponse.self, from: Data(json.utf8))
    }
}

final class ExternalTranscriptClientTests: XCTestCase {
    func test404IsReportedAsHTTPStatus() async throws {
        let client = try makeClient(protocolClass: ExternalTranscript404URLProtocol.self)

        do {
            _ = try await client.externalTranscript(sessionId: "codex:missing")
            XCTFail("404 must not decode as a transcript")
        } catch let error as DashboardClientError {
            guard case .httpStatus(404) = error else {
                return XCTFail("expected httpStatus(404), got \(error)")
            }
        } catch {
            XCTFail("expected DashboardClientError, got \(error)")
        }
    }

    func testTransportFailureRemainsTransportError() async throws {
        let client = try makeClient(protocolClass: ExternalTranscriptTransportURLProtocol.self)

        do {
            _ = try await client.externalTranscript(sessionId: "codex:offline")
            XCTFail("transport failure must throw")
        } catch let error as URLError {
            XCTAssertEqual(error.code, .cannotConnectToHost)
        } catch {
            XCTFail("expected URLError, got \(error)")
        }
    }

    func testSessionIDColonIsPercentEncodedInPath() async throws {
        let client = try makeClient(protocolClass: ExternalTranscriptEncodedPathURLProtocol.self)

        let transcript = try await client.externalTranscript(sessionId: "codex:cx-gap2")

        XCTAssertEqual(transcript.id, "codex:cx-gap2")
    }

    private func makeClient(protocolClass: AnyClass) throws -> RestClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [protocolClass]
        return RestClient(
            base: try XCTUnwrap(URL(string: "http://dashboard.test:8000")),
            session: URLSession(configuration: configuration))
    }
}

private final class ExternalTranscript404URLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        respond(status: 404, body: #"{"error":"external session not found"}"#)
    }

    override func stopLoading() {}
}

private final class ExternalTranscriptTransportURLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
    }

    override func stopLoading() {}
}

private final class ExternalTranscriptEncodedPathURLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let path = request.url.flatMap {
            URLComponents(url: $0, resolvingAgainstBaseURL: false)?.percentEncodedPath
        }
        if path == "/api/external-sessions/codex%3Acx-gap2/transcript" {
            respond(
                status: 200,
                body: #"{"id":"codex:cx-gap2","source":"codex","entries":[],"truncated":false}"#)
        } else {
            respond(status: 400, body: #"{"error":"unencoded path"}"#)
        }
    }

    override func stopLoading() {}
}

private extension URLProtocol {
    func respond(status: Int, body: String) {
        let response = HTTPURLResponse(
            url: request.url!, statusCode: status, httpVersion: nil,
            headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
}
