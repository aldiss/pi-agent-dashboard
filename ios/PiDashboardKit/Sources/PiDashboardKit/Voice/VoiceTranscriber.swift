import Foundation

/// Pure, UI-free HTTP contract for the dashboard's **parakeet voice sidecar** — the
/// exact backend the PWA `PushToTalkButton` uses. The app target records audio
/// (`AVAudioRecorder` → m4a) and runs the live `URLSession`; everything that can be
/// pinned without a device — endpoint URLs, multipart framing, auth header, and the
/// `{ transcript }` response decode — lives here and is covered by `swift test`.
///
/// Contract (verified live by SwiftPilot):
/// - `POST <base>/api/plugins/voice-input/transcribe`, `multipart/form-data`, ONE
///   field `audio`, filename `recording.m4a`, part type `audio/mp4`. Bearer token
///   when present. Response `{ transcript, engine_used, duration_ms }`.
/// - `GET <base>/api/plugins/voice-input/health` → `{ healthy: Bool, engine: String }`.
public enum VoiceTranscriber {

    public static let transcribePath = "api/plugins/voice-input/transcribe"
    public static let healthPath = "api/plugins/voice-input/health"
    public static let audioFieldName = "audio"
    public static let audioFilename = "recording.m4a"
    public static let audioContentType = "audio/mp4"

    // MARK: URLs

    /// `<base>/api/plugins/voice-input/transcribe`, tolerant of a trailing slash on base.
    public static func transcribeURL(base: URL) -> URL {
        appending(transcribePath, to: base)
    }

    /// `<base>/api/plugins/voice-input/health`.
    public static func healthURL(base: URL) -> URL {
        appending(healthPath, to: base)
    }

    private static func appending(_ path: String, to base: URL) -> URL {
        // Normalize so `http://h:8000` and `http://h:8000/` both yield one clean join.
        var s = base.absoluteString
        while s.hasSuffix("/") { s.removeLast() }
        return URL(string: "\(s)/\(path)") ?? base.appendingPathComponent(path)
    }

    // MARK: Multipart body

    /// Frame one `audio` part as `multipart/form-data`. `boundary` is injected (not
    /// generated here) so the byte layout is deterministic + unit-testable; the app
    /// passes a fresh `UUID().uuidString`. CRLF line endings per RFC 7578.
    public static func multipartBody(audio: Data, boundary: String,
                                     filename: String = audioFilename,
                                     contentType: String = audioContentType) -> Data {
        var body = Data()
        func put(_ s: String) { body.append(Data(s.utf8)) }
        put("--\(boundary)\r\n")
        put("Content-Disposition: form-data; name=\"\(audioFieldName)\"; filename=\"\(filename)\"\r\n")
        put("Content-Type: \(contentType)\r\n\r\n")
        body.append(audio)
        put("\r\n--\(boundary)--\r\n")
        return body
    }

    /// The `Content-Type` header value pairing with `multipartBody(boundary:)`.
    public static func multipartContentType(boundary: String) -> String {
        "multipart/form-data; boundary=\(boundary)"
    }

    /// Build the fully-formed transcribe `URLRequest` (method, headers, body, 120s
    /// timeout). Bearer header added only when `token` is non-empty.
    public static func transcribeRequest(base: URL, audio: Data, boundary: String,
                                         token: String? = nil,
                                         timeout: TimeInterval = 120) -> URLRequest {
        var req = URLRequest(url: transcribeURL(base: base))
        req.httpMethod = "POST"
        req.timeoutInterval = timeout
        req.setValue(multipartContentType(boundary: boundary), forHTTPHeaderField: "Content-Type")
        if let token, !token.isEmpty {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        req.httpBody = multipartBody(audio: audio, boundary: boundary)
        return req
    }

    /// Build the health-probe `GET` (short timeout — it's a liveness poll).
    public static func healthRequest(base: URL, token: String? = nil,
                                     timeout: TimeInterval = 8) -> URLRequest {
        var req = URLRequest(url: healthURL(base: base))
        req.httpMethod = "GET"
        req.timeoutInterval = timeout
        if let token, !token.isEmpty {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return req
    }

    // MARK: Response decode

    public struct TranscribeResponse: Decodable, Sendable, Equatable {
        public let transcript: String
        public let engineUsed: String?
        public let durationMs: Double?
        private enum CodingKeys: String, CodingKey {
            case transcript
            case engineUsed = "engine_used"
            case durationMs = "duration_ms"
        }
    }

    public enum TranscribeError: Error, Equatable {
        case malformed          // body wasn't the expected JSON shape
        case emptyTranscript    // valid JSON, but no speech detected
    }

    /// Decode the transcribe body to a TRIMMED transcript, or a typed error. Empty /
    /// whitespace-only transcript → `.emptyTranscript` (caller shows "No speech
    /// detected", inserts nothing). Mirrors the PWA `(data.transcript || "").trim()`.
    public static func parseTranscript(_ data: Data) -> Result<String, TranscribeError> {
        guard let decoded = try? JSONDecoder().decode(TranscribeResponse.self, from: data) else {
            return .failure(.malformed)
        }
        let trimmed = decoded.transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? .failure(.emptyTranscript) : .success(trimmed)
    }

    public struct HealthResponse: Decodable, Sendable, Equatable {
        public let healthy: Bool
        public let engine: String?
    }

    /// Health is true only on a 2xx status AND a `healthy:true` body. A 503 (sidecar
    /// warming) or any non-2xx → false, regardless of body. Mirrors the PWA gate.
    public static func parseHealthy(_ data: Data, statusCode: Int) -> Bool {
        guard (200..<300).contains(statusCode) else { return false }
        guard let decoded = try? JSONDecoder().decode(HealthResponse.self, from: data) else {
            return false
        }
        return decoded.healthy
    }
}
