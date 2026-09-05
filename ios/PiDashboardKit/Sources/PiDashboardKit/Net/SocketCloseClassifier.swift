import Foundation

/// How a WebSocket connection ended, as far as the endpoint can actually tell.
///
/// The client mirror of the server's `bridge-disconnect-classifier`, which already
/// declares `closeCode?: number`. Keeping one vocabulary across both ends means a
/// disconnect can be described the same way wherever it is observed.
public enum SocketCloseKind: Sendable, Equatable {
    /// The peer sent an RFC 6455 close frame — it chose to close, and said so.
    case orderly(code: Int, reason: String?)
    /// No close frame arrived. The transport died underneath the connection.
    case abrupt

    /// One line fit for a log or a diagnostic surface. The code is the evidence, so
    /// it always survives into the text.
    public var summary: String {
        switch self {
        case .abrupt:
            return "abrupt drop — no close frame (transport died)"
        case .orderly(let code, let reason):
            guard let reason else { return "orderly close — code \(code)" }
            return "orderly close — code \(code): \(reason)"
        }
    }
}

/// Turns what `URLSessionWebSocketTask` knows at death into something a human can act on.
///
/// WHY THIS EXISTS (B10). When the socket flaps — accepted, then dead 186-337ms later,
/// repeatedly — the client records only `error.localizedDescription`, which is the same
/// generic string whether a peer closed deliberately or the network vanished. The server
/// half has the mirror defect: its close handler takes no parameters and discards the
/// `(code, reason)` the `ws` library passes. With both ends mute, every B10 investigation
/// has had to argue from an absence that carries no information.
///
/// WHAT IT PROVES, AND THE BOUND ON THAT — do not over-read this later. An RFC 6455 code
/// can be absent entirely on an abrupt transport drop, so this separates ORDERLY from
/// ABRUPT only. It does NOT attribute a cause to the server, the Cloudflare tunnel, or the
/// mobile network. It splits the space; it does not settle it. An orderly close means some
/// peer decided to close and is therefore attributable in principle; an abrupt drop rules
/// out a deliberate application-level close and points at the transport, without naming
/// which hop.
///
/// Pure — takes the raw code and payload rather than a `URLSessionWebSocketTask` — so every
/// branch is reachable from `swift test` without a live socket.
public enum SocketCloseClassifier {

    /// - Parameters:
    ///   - closeCodeRawValue: `URLSessionWebSocketTask.closeCode.rawValue`.
    ///     `URLSessionWebSocketTask.CloseCode.invalid` is 0 and means no close frame was seen.
    ///   - reason: `URLSessionWebSocketTask.closeReason`, a UTF-8 payload when present.
    public static func classify(closeCodeRawValue: Int, reason: Data?) -> SocketCloseKind {
        guard closeCodeRawValue != 0 else { return .abrupt }
        return .orderly(code: closeCodeRawValue, reason: decodeReason(reason))
    }

    /// Absent, empty and undecodable payloads all mean "no reason available". Losing an
    /// unreadable reason is acceptable; losing the code with it is not, so this never throws.
    private static func decodeReason(_ reason: Data?) -> String? {
        guard let reason, !reason.isEmpty,
              let text = String(data: reason, encoding: .utf8),
              !text.isEmpty else { return nil }
        return text
    }
}
