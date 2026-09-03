import XCTest
@testable import PiDashboardKit

final class ExternalSessionMapperTests: XCTestCase {
    func testCapturedExternalSessionPayloadMapsToDashboardSession() throws {
        let json = #"""
        {
          "sessions": [
            {
              "id": "claude-code:cc-stubboot-step2",
              "runtime": "claude-code",
              "tmuxSession": "cc-stubboot-step2",
              "tmuxSocket": "pi",
              "title": "cc-stubboot-step2",
              "cwd": "/Users/..."
            }
          ]
        }
        """#.data(using: .utf8)!

        let response = try JSONDecoder().decode(ExternalSessionsResponse.self, from: json)
        let mapped = try XCTUnwrap(response.sessions.first.map {
            ExternalSessionMapper.map($0, now: 9_999)
        })

        XCTAssertEqual(response.owners, [:])
        XCTAssertEqual(response.drivers, [])
        XCTAssertEqual(mapped.id, "claude-code:cc-stubboot-step2")
        XCTAssertEqual(mapped.cwd, "/Users/...")
        XCTAssertEqual(mapped.name, "cc-stubboot-step2")
        XCTAssertEqual(mapped.source, "claude-code")
        XCTAssertEqual(mapped.status, "active")
        XCTAssertEqual(mapped.model, "claude-code/unknown model")
        XCTAssertNil(mapped.thinkingLevel)
        XCTAssertEqual(mapped.startedAt, 9_999)
        XCTAssertEqual(mapped.lastActivityAt, 9_999)
        XCTAssertNil(mapped.endedAt)
        XCTAssertEqual(mapped.bridgeConnected, true)
        XCTAssertNil(mapped.pid)
        XCTAssertEqual(mapped.external, ExternalSessionMetadata(
            runtime: .claudeCode,
            tmuxSession: "cc-stubboot-step2",
            readOnly: true,
            outputChangedAt: nil,
            lineCount: nil))
    }

    func testCanonicalFullPayloadUsesOutputActivityModelEffortAndPid() throws {
        let json = #"""
        {
          "sessions": [
            {
              "id": "codex:cx-gap2",
              "runtime": "codex",
              "tmuxSession": "cx-gap2",
              "tmuxSocket": "pi",
              "title": "cx-gap2",
              "cwd": "/tmp/gap2",
              "runtimePid": 4242,
              "state": "live",
              "model": "gpt-5.6-sol",
              "effort": "ultra",
              "firstSeenAt": 1000,
              "lastLiveAt": 2000,
              "endedAt": null,
              "output": "working",
              "outputAt": 2000,
              "outputChangedAt": 1900,
              "lineCount": 1
            }
          ],
          "owners": {},
          "drivers": []
        }
        """#.data(using: .utf8)!

        let response = try JSONDecoder().decode(ExternalSessionsResponse.self, from: json)
        let mapped = try XCTUnwrap(response.sessions.first.map {
            ExternalSessionMapper.map($0, now: 9_999)
        })

        XCTAssertEqual(mapped.model, "codex/gpt-5.6-sol")
        XCTAssertEqual(mapped.thinkingLevel, "ultra")
        XCTAssertEqual(mapped.startedAt, 1_000)
        XCTAssertEqual(mapped.lastActivityAt, 1_900)
        XCTAssertEqual(mapped.pid, 4_242)
        XCTAssertEqual(mapped.external?.lineCount, 1)
    }
}

final class ExternalSessionLoadingTests: XCTestCase {
    private enum StubFailure: Error { case unavailable }

    func testExternalFetchFailureLeavesPiSessionListUnchanged() async {
        let piSessions = [
            DashboardSession(id: "pi-1", cwd: "/one", name: "Joan", source: "tmux"),
            DashboardSession(id: "pi-2", cwd: "/two", name: "Scratch", source: "tui"),
        ]

        let external = await ExternalSessionSource.refresh(current: [], now: 9_999) {
            throw StubFailure.unavailable
        }
        let rendered = ExternalSessionSource.merge(
            piSessions: piSessions, externalSessions: external)

        XCTAssertEqual(rendered, piSessions)
    }

    func testExternalFetchFailurePreservesLastSuccessfulSnapshot() async {
        var prior = DashboardSession(
            id: "codex:cx-prior", cwd: "/prior", name: "cx-prior", source: "codex")
        prior.external = ExternalSessionMetadata(
            runtime: .codex, tmuxSession: "cx-prior", readOnly: true)

        let refreshed = await ExternalSessionSource.refresh(current: [prior], now: 9_999) {
            throw StubFailure.unavailable
        }

        XCTAssertEqual(refreshed, [prior])
    }

    func testExternalSessionsEndpointRejects503() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ExternalSessions503URLProtocol.self]
        let client = RestClient(
            base: try XCTUnwrap(URL(string: "http://dashboard.test:8000")),
            session: URLSession(configuration: configuration))

        do {
            _ = try await client.externalSessions()
            XCTFail("503 must not decode as an empty external-session snapshot")
        } catch let error as DashboardClientError {
            guard case .httpStatus(503) = error else {
                return XCTFail("expected httpStatus(503), got \(error)")
            }
        } catch {
            XCTFail("expected DashboardClientError, got \(error)")
        }
    }
}

private final class ExternalSessions503URLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let response = HTTPURLResponse(
            url: request.url!, statusCode: 503, httpVersion: nil,
            headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(#"{"error":"unavailable"}"#.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
