import XCTest
@testable import PiDashboardKit

/// Unit tests for the parakeet voice-sidecar HTTP contract (pure: URL building,
/// multipart framing, auth header, response decode). Simulator-free — the live
/// recording + upload is device-only and verified by SwiftPilot.
final class VoiceTranscriberTests: XCTestCase {

    private let base = URL(string: "http://host:8000")!

    // MARK: URLs

    func testTranscribeURL() {
        XCTAssertEqual(VoiceTranscriber.transcribeURL(base: base).absoluteString,
                       "http://host:8000/api/plugins/voice-input/transcribe")
    }

    func testHealthURL() {
        XCTAssertEqual(VoiceTranscriber.healthURL(base: base).absoluteString,
                       "http://host:8000/api/plugins/voice-input/health")
    }

    func testURLToleratesTrailingSlashOnBase() {
        let slashed = URL(string: "http://host:8000/")!
        XCTAssertEqual(VoiceTranscriber.transcribeURL(base: slashed).absoluteString,
                       "http://host:8000/api/plugins/voice-input/transcribe")
    }

    func testURLWorksWithTailscaleHostNoPort() {
        let ts = URL(string: "https://mac.tailnet.ts.net")!
        XCTAssertEqual(VoiceTranscriber.transcribeURL(base: ts).absoluteString,
                       "https://mac.tailnet.ts.net/api/plugins/voice-input/transcribe")
    }

    // MARK: Multipart framing

    func testMultipartBodyFraming() {
        let audio = Data([0x00, 0x01, 0x02, 0x03])
        let body = VoiceTranscriber.multipartBody(audio: audio, boundary: "B0UND")
        let text = String(decoding: body, as: UTF8.self)
        XCTAssertTrue(text.hasPrefix("--B0UND\r\n"))
        XCTAssertTrue(text.contains(
            "Content-Disposition: form-data; name=\"audio\"; filename=\"recording.m4a\"\r\n"))
        XCTAssertTrue(text.contains("Content-Type: audio/mp4\r\n\r\n"))
        XCTAssertTrue(text.hasSuffix("\r\n--B0UND--\r\n"))
        // Raw audio bytes survive verbatim inside the part.
        XCTAssertTrue(body.range(of: audio) != nil)
    }

    func testMultipartContentTypeHeader() {
        XCTAssertEqual(VoiceTranscriber.multipartContentType(boundary: "XYZ"),
                       "multipart/form-data; boundary=XYZ")
    }

    // MARK: Requests

    func testTranscribeRequestShape() {
        let req = VoiceTranscriber.transcribeRequest(
            base: base, audio: Data([0xAA]), boundary: "BB", token: nil)
        XCTAssertEqual(req.httpMethod, "POST")
        XCTAssertEqual(req.url?.absoluteString,
                       "http://host:8000/api/plugins/voice-input/transcribe")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Content-Type"),
                       "multipart/form-data; boundary=BB")
        XCTAssertEqual(req.timeoutInterval, 120, accuracy: 0.001)
        XCTAssertNil(req.value(forHTTPHeaderField: "Authorization"))
        XCTAssertNotNil(req.httpBody)
    }

    func testTranscribeRequestAddsBearerWhenTokenPresent() {
        let req = VoiceTranscriber.transcribeRequest(
            base: base, audio: Data([0xAA]), boundary: "BB", token: "secret")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer secret")
    }

    func testTranscribeRequestNoBearerForEmptyToken() {
        let req = VoiceTranscriber.transcribeRequest(
            base: base, audio: Data([0xAA]), boundary: "BB", token: "")
        XCTAssertNil(req.value(forHTTPHeaderField: "Authorization"))
    }

    func testHealthRequestShape() {
        let req = VoiceTranscriber.healthRequest(base: base, token: "t")
        XCTAssertEqual(req.httpMethod, "GET")
        XCTAssertEqual(req.url?.absoluteString,
                       "http://host:8000/api/plugins/voice-input/health")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer t")
    }

    // MARK: Transcript decode

    func testParseTranscriptSuccessTrims() {
        let json = #"{"transcript":"  привет мир  ","engine_used":"parakeet","duration_ms":4200}"#
        let result = VoiceTranscriber.parseTranscript(Data(json.utf8))
        XCTAssertEqual(try? result.get(), "привет мир")
    }

    func testParseTranscriptEmptyIsEmptyError() {
        let json = #"{"transcript":"   ","engine_used":"parakeet","duration_ms":120}"#
        let result = VoiceTranscriber.parseTranscript(Data(json.utf8))
        if case .failure(let e) = result { XCTAssertEqual(e, .emptyTranscript) }
        else { XCTFail("expected emptyTranscript") }
    }

    func testParseTranscriptMissingFieldIsMalformed() {
        let json = #"{"engine_used":"parakeet"}"#
        let result = VoiceTranscriber.parseTranscript(Data(json.utf8))
        if case .failure(let e) = result { XCTAssertEqual(e, .malformed) }
        else { XCTFail("expected malformed") }
    }

    func testParseTranscriptGarbageIsMalformed() {
        let result = VoiceTranscriber.parseTranscript(Data("not json".utf8))
        if case .failure(let e) = result { XCTAssertEqual(e, .malformed) }
        else { XCTFail("expected malformed") }
    }

    func testParseTranscriptToleratesMissingOptionalFields() {
        // Only `transcript` is required; engine_used/duration_ms optional.
        let result = VoiceTranscriber.parseTranscript(Data(#"{"transcript":"hi"}"#.utf8))
        XCTAssertEqual(try? result.get(), "hi")
    }

    // MARK: Health decode

    func testParseHealthyTrueOn200() {
        XCTAssertTrue(VoiceTranscriber.parseHealthy(
            Data(#"{"healthy":true,"engine":"parakeet"}"#.utf8), statusCode: 200))
    }

    func testParseHealthyFalseOn503() {
        // Sidecar warming: 503 → not healthy regardless of body.
        XCTAssertFalse(VoiceTranscriber.parseHealthy(
            Data(#"{"healthy":false}"#.utf8), statusCode: 503))
    }

    func testParseHealthyFalseWhenBodySaysFalse() {
        XCTAssertFalse(VoiceTranscriber.parseHealthy(
            Data(#"{"healthy":false,"engine":"none"}"#.utf8), statusCode: 200))
    }

    func testParseHealthyFalseOnGarbage() {
        XCTAssertFalse(VoiceTranscriber.parseHealthy(Data("nope".utf8), statusCode: 200))
    }
}
