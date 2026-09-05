import Foundation

/// Entry kind returned by `GET /api/external-sessions/:id/transcript`.
/// Unknown values remain renderable instead of invalidating the full response.
public enum ExternalTranscriptEntryKind: String, Codable, Sendable, Equatable {
    case user
    case assistant
    case thinking
    case toolCall = "tool_call"
    case toolResult = "tool_result"
    case status
    case unknown

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let rawValue = (try? container.decode(String.self)) ?? ""
        self = Self(rawValue: rawValue) ?? .unknown
    }
}

/// One normalized transcript entry from an external Codex or Claude Code session.
public struct ExternalTranscriptEntry: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let ts: Double
    public let kind: ExternalTranscriptEntryKind
    public let text: String?
    public let toolName: String?
    public let toolInput: JSONValue?
    public let toolResult: String?
    public let toolCallId: String?
    public let isError: Bool?
    public let durationMs: Double?

    /// Server uses zero when the source row has no usable timestamp.
    public var timestamp: Double? { ts > 0 ? ts : nil }
}

/// Response envelope for `GET /api/external-sessions/:id/transcript`.
public struct ExternalTranscriptResponse: Codable, Sendable, Equatable {
    public let id: String
    public let source: String
    public let entries: [ExternalTranscriptEntry]
    public let truncated: Bool
    public let transcriptPath: String?
}

/// Status has no `ChatRole` analogue, so the viewer renders this as a muted line.
public struct ExternalTranscriptStatus: Sendable, Equatable, Identifiable {
    public let id: String
    public let text: String
    public let timestamp: Double?
}

/// Adapter output for the read-only viewer. All non-status content reuses `ChatMessage`.
public enum ExternalTranscriptRow: Sendable, Equatable, Identifiable {
    case message(ChatMessage)
    case status(ExternalTranscriptStatus)

    public var id: String {
        switch self {
        case .message(let message): message.id
        case .status(let status): status.id
        }
    }
}

/// Converts external entries into the app's existing chat-row model.
public enum ExternalTranscriptMapper {
    public static func rows(from entries: [ExternalTranscriptEntry]) -> [ExternalTranscriptRow] {
        var rows: [ExternalTranscriptRow] = []
        var toolRowByCallID: [String: Int] = [:]

        for entry in entries {
            switch entry.kind {
            case .user:
                rows.append(.message(message(entry, role: .user)))

            case .assistant:
                rows.append(.message(message(entry, role: .assistant)))

            case .thinking:
                rows.append(.message(message(entry, role: .thinking)))

            case .toolCall:
                let message = ChatMessage(
                    id: entry.id,
                    role: .toolResult,
                    content: entry.text ?? entry.toolName ?? "Tool",
                    toolName: entry.toolName,
                    toolCallId: entry.toolCallId,
                    toolStatus: .running,
                    result: entry.toolResult,
                    timestamp: entry.ts,
                    startedAt: entry.timestamp,
                    duration: entry.durationMs,
                    args: toolArguments(entry.toolInput))
                rows.append(.message(message))
                if let toolCallID = entry.toolCallId {
                    toolRowByCallID[toolCallID] = rows.index(before: rows.endIndex)
                }

            case .toolResult:
                let result = entry.toolResult ?? entry.text
                if let toolCallID = entry.toolCallId,
                   let index = toolRowByCallID[toolCallID],
                   case .message(var message) = rows[index] {
                    if let toolName = entry.toolName { message.toolName = toolName }
                    if let toolInput = entry.toolInput { message.args = toolArguments(toolInput) }
                    message.toolStatus = entry.isError == true ? .error : .complete
                    message.result = result
                    message.duration = entry.durationMs ?? elapsedDuration(
                        from: message.startedAt, to: entry.timestamp)
                    rows[index] = .message(message)
                } else {
                    rows.append(.message(ChatMessage(
                        id: entry.id,
                        role: .toolResult,
                        content: entry.text ?? entry.toolName ?? "Tool",
                        toolName: entry.toolName,
                        toolCallId: entry.toolCallId,
                        toolStatus: entry.isError == true ? .error : .complete,
                        result: result,
                        timestamp: entry.ts,
                        duration: entry.durationMs,
                        args: toolArguments(entry.toolInput))))
                }

            case .status:
                rows.append(.status(ExternalTranscriptStatus(
                    id: entry.id,
                    text: entry.text ?? "Status",
                    timestamp: entry.timestamp)))

            case .unknown:
                rows.append(.message(ChatMessage(
                    id: entry.id,
                    role: .rawEvent,
                    content: entry.text ?? entry.toolResult ?? "",
                    toolName: "Unknown transcript entry",
                    timestamp: entry.ts)))
            }
        }

        return rows
    }

    private static func message(_ entry: ExternalTranscriptEntry, role: ChatRole) -> ChatMessage {
        ChatMessage(
            id: entry.id,
            role: role,
            content: entry.text ?? "",
            timestamp: entry.ts)
    }

    private static func toolArguments(_ input: JSONValue?) -> [String: JSONValue] {
        guard let input else { return [:] }
        return input.objectValue ?? ["input": input]
    }

    private static func elapsedDuration(from start: Double?, to end: Double?) -> Double? {
        guard let start, let end else { return nil }
        return max(0, end - start)
    }
}
