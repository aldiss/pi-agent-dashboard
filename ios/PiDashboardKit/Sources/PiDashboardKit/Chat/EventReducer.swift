import Foundation

/// The role a rendered chat row plays. Faithful subset of the `ChatMessage.role`
/// union in `packages/client/src/lib/event-reducer.ts` (the MVP renders text /
/// thinking / tool call+result / turn separators / bash output / raw events;
/// interactive-UI, command-feedback queue cards and flow/architect panels are
/// deferred per DESIGN.md §7).
public enum ChatRole: String, Sendable, Equatable {
    case user, assistant, toolResult, thinking, bashOutput, commandFeedback, turnSeparator, rawEvent
}

public enum ToolStatus: String, Sendable, Equatable {
    case running, complete, error
}

/// A single renderable chat row — the native mirror of `ChatMessage`. Identity is
/// the stable `id` (content-stable across replay so re-reducing the same event
/// stream never double-pushes a row).
public struct ChatMessage: Sendable, Equatable, Identifiable {
    public var id: String
    public var role: ChatRole
    public var content: String
    public var images: [ImageContent]
    public var toolName: String?
    public var toolCallId: String?
    public var toolStatus: ToolStatus?
    public var result: String?
    public var timestamp: Double
    public var startedAt: Double?
    public var duration: Double?
    /// Free-form per-row metadata (e.g. bash `command`/`exitCode`, command-feedback `status`).
    public var args: [String: JSONValue]

    public init(id: String, role: ChatRole, content: String, images: [ImageContent] = [],
                toolName: String? = nil, toolCallId: String? = nil, toolStatus: ToolStatus? = nil,
                result: String? = nil, timestamp: Double, startedAt: Double? = nil,
                duration: Double? = nil, args: [String: JSONValue] = [:]) {
        self.id = id; self.role = role; self.content = content; self.images = images
        self.toolName = toolName; self.toolCallId = toolCallId; self.toolStatus = toolStatus
        self.result = result; self.timestamp = timestamp; self.startedAt = startedAt
        self.duration = duration; self.args = args
    }
}

/// In-flight tool call bookkeeping (mirrors `ToolCallState`).
public struct ToolCallState: Sendable, Equatable {
    public var toolCallId: String
    public var toolName: String
    public var status: ToolStatus
    public var result: String?
}

/// Per-turn token accounting (mirrors `TurnStat`).
public struct TurnStat: Sendable, Equatable {
    public var input: Double
    public var output: Double
    public var cacheRead: Double
    public var cacheWrite: Double
}

/// A subagent surfaced by `@tintinweb/pi-subagents` (mirrors `SubagentState`).
public struct SubagentState: Sendable, Equatable, Identifiable {
    public var id: String
    public var type: String
    public var description: String
    public var status: String  // created | running | completed | failed
    public var result: String?
    public var error: String?
}

/// The reduced chat state for one session — the native mirror of `SessionState`
/// (MVP subset). `reduce(_:)` folds a `DashboardEvent` stream into renderable
/// rows + running stats, faithful to `reduceEvent` for the event types the MVP
/// renders. Pure value type: `swift test`-able with zero UI / simulator.
public struct ChatSessionState: Sendable, Equatable {
    public var messages: [ChatMessage] = []
    public var toolCalls: [String: ToolCallState] = [:]
    public var streamingText: String = ""
    public var streamingThinking: String = ""
    public var thinkingStartedAt: Double?
    public var isStreaming: Bool = false
    public var status: String = "idle"  // idle | streaming | ended
    public var model: String?
    public var thinkingLevel: String?
    public var tokensIn: Double = 0
    public var tokensOut: Double = 0
    public var cacheRead: Double = 0
    public var cacheWrite: Double = 0
    public var cost: Double = 0
    public var currentTool: String?
    public var turnStats: [TurnStat] = []
    public var contextTokens: Double?
    public var contextWindow: Double?
    public var subagents: [String: SubagentState] = [:]
    /// True once the current assistant message's streaming text has been flushed
    /// into a permanent row (mirrors `streamingTextFlushed`). Reset at each
    /// assistant message_start and message_end.
    public var streamingTextFlushed: Bool = false

    public init() {}

    private static let maxTurnStats = 50

    /// Fold one event into a new state. Pure: `self` is not mutated.
    public func reduce(_ event: DashboardEvent) -> ChatSessionState {
        var next = self
        let data = event.data
        let ts = event.timestamp

        switch event.eventType {
        case "agent_start":
            next.isStreaming = true
            next.status = "streaming"
            next.streamingText = ""

        case "agent_end":
            next.isStreaming = false
            next.status = "idle"
            next.streamingText = ""
            next.currentTool = nil

        case "message_start":
            let role = next.messageRole(data)
            if role == "assistant" {
                next.streamingTextFlushed = false
            }
            if role == "user" {
                let (text, images) = ChatSessionState.extractMessageTextAndImages(data["message"])
                next.messages.append(ChatMessage(
                    id: "msg-\(next.messages.count)", role: .user, content: text,
                    images: images, timestamp: ts))
            }

        case "message_update":
            if let ev = data["assistantMessageEvent"]?.objectValue,
               let type = ev["type"]?.stringValue {
                switch type {
                case "thinking_start":
                    next.streamingThinking = ""
                    next.thinkingStartedAt = ts
                case "thinking_delta":
                    next.streamingThinking += ev["delta"]?.stringValue ?? ""
                case "thinking_end":
                    if !next.streamingThinking.isEmpty {
                        let started = next.thinkingStartedAt
                        next.messages.append(ChatMessage(
                            id: "thinking-\(next.messages.count)", role: .thinking,
                            content: next.streamingThinking, timestamp: ts,
                            startedAt: started, duration: started.map { ts - $0 }))
                    }
                    next.streamingThinking = ""
                    next.thinkingStartedAt = nil
                default: break
                }
                break
            }
            if next.messageRole(data) == "assistant", !next.streamingTextFlushed {
                let (text, _) = ChatSessionState.extractMessageTextAndImages(data["message"])
                next.streamingText = text
            }

        case "message_end":
            if next.messageRole(data) == "assistant" {
                if next.streamingTextFlushed {
                    // already flushed at tool_execution_start; nothing to push
                } else if !next.streamingText.isEmpty {
                    next.messages.append(ChatMessage(
                        id: "msg-\(next.messages.count)", role: .assistant,
                        content: next.streamingText, timestamp: ts))
                    next.streamingText = ""
                } else {
                    let (replayText, _) = ChatSessionState.extractMessageTextAndImages(data["message"])
                    if !replayText.isEmpty {
                        next.messages.append(ChatMessage(
                            id: "msg-\(next.messages.count)", role: .assistant,
                            content: replayText, timestamp: ts))
                    } else if next.messages.last?.role == .toolResult {
                        // Tool-only assistant turn — thin separator so consecutive
                        // tool groups don't blend together.
                        next.messages.append(ChatMessage(
                            id: "sep-\(next.messages.count)", role: .turnSeparator,
                            content: "", timestamp: ts))
                    }
                }
                next.streamingTextFlushed = false
            }

        case "tool_execution_start":
            guard let toolCallId = data["toolCallId"]?.stringValue,
                  let toolName = data["toolName"]?.stringValue else { break }
            // Flush pending streamingText into a permanent assistant row BEFORE the
            // tool row so the model's content-array order survives the whole tool
            // runtime (mirrors flushStreamingTextAsAssistantRow). Flush id keyed on
            // toolCallId → replay-idempotent.
            if !next.streamingText.isEmpty, !next.streamingTextFlushed {
                let flushId = "flush-\(toolCallId)"
                if !next.messages.contains(where: { $0.role == .assistant && $0.id == flushId }) {
                    next.messages.append(ChatMessage(
                        id: flushId, role: .assistant, content: next.streamingText, timestamp: ts))
                }
                next.streamingText = ""
                next.streamingTextFlushed = true
            }
            next.toolCalls[toolCallId] = ToolCallState(
                toolCallId: toolCallId, toolName: toolName, status: .running)
            next.currentTool = toolName
            // Idempotent on toolCallId: refresh in place if a row already exists.
            if let idx = next.messages.lastIndex(where: { $0.role == .toolResult && $0.toolCallId == toolCallId }) {
                next.messages[idx].toolName = toolName
            } else {
                next.messages.append(ChatMessage(
                    id: "tool-\(toolCallId)", role: .toolResult, content: toolName,
                    toolName: toolName, toolCallId: toolCallId, toolStatus: .running,
                    timestamp: ts, startedAt: ts))
            }

        case "tool_execution_update":
            guard let toolCallId = data["toolCallId"]?.stringValue else { break }
            if let partial = ChatSessionState.displayString(data["partialResult"]),
               let idx = next.messages.lastIndex(where: { $0.toolCallId == toolCallId }) {
                next.messages[idx].result = ChatSessionState.truncateLines(partial, 30)
            }

        case "tool_execution_end":
            guard let toolCallId = data["toolCallId"]?.stringValue else { break }
            let isError = data["isError"]?.boolValue ?? false
            if var existing = next.toolCalls[toolCallId] {
                existing.status = isError ? .error : .complete
                next.toolCalls[toolCallId] = existing
            }
            next.currentTool = nil
            if let idx = next.messages.lastIndex(where: { $0.toolCallId == toolCallId }) {
                next.messages[idx].toolStatus = isError ? .error : .complete
                if let result = ChatSessionState.displayString(data["result"]) {
                    next.messages[idx].result = ChatSessionState.truncateLines(result, 30)
                }
                if let started = next.messages[idx].startedAt {
                    next.messages[idx].duration = ts - started
                }
                if let images = ChatSessionState.extractImages(data["images"]) {
                    next.messages[idx].images = images
                }
            }

        case "stats_update":
            if let v = data["tokensIn"]?.numberValue { next.tokensIn += v }
            if let v = data["tokensOut"]?.numberValue { next.tokensOut += v }
            if let v = data["cost"]?.numberValue { next.cost += v }
            if let turn = data["turnUsage"]?.objectValue {
                let stat = TurnStat(
                    input: turn["input"]?.numberValue ?? 0,
                    output: turn["output"]?.numberValue ?? 0,
                    cacheRead: turn["cacheRead"]?.numberValue ?? 0,
                    cacheWrite: turn["cacheWrite"]?.numberValue ?? 0)
                next.turnStats = Array((next.turnStats + [stat]).suffix(ChatSessionState.maxTurnStats))
                next.cacheRead += stat.cacheRead
                next.cacheWrite += stat.cacheWrite
            }
            if let ctx = data["contextUsage"]?.objectValue {
                next.contextTokens = ctx["tokens"]?.numberValue
                next.contextWindow = ctx["contextWindow"]?.numberValue
            }

        case "model_select":
            if let model = data["model"]?.objectValue,
               let provider = model["provider"]?.stringValue, let id = model["id"]?.stringValue {
                next.model = "\(provider)/\(id)"
            }
            if let level = data["thinkingLevel"]?.stringValue { next.thinkingLevel = level }

        case "session_compact":
            next.messages.append(ChatMessage(
                id: "compact-\(next.messages.count)", role: .assistant,
                content: "── Session compacted ──", timestamp: ts))

        case "bash_output":
            next.messages.append(ChatMessage(
                id: "bash-\(next.messages.count)", role: .bashOutput,
                content: data["output"]?.stringValue ?? "", timestamp: ts,
                args: ["command": data["command"] ?? .null, "exitCode": data["exitCode"] ?? .null]))

        case "command_feedback":
            let command = data["command"]?.stringValue ?? ""
            let status = data["status"]?.stringValue ?? ""
            let message = data["message"]?.stringValue ?? ""
            // Upsert: a terminal status transitions the most recent matching
            // started row in place (mirrors the PWA upsert).
            if status == "completed" || status == "error",
               let idx = next.messages.lastIndex(where: {
                   $0.role == .commandFeedback && $0.args["command"]?.stringValue == command
                       && $0.args["status"]?.stringValue == "started"
               }) {
                next.messages[idx].content = message
                next.messages[idx].timestamp = ts
                next.messages[idx].args = ["command": .string(command), "status": .string(status)]
            } else {
                next.messages.append(ChatMessage(
                    id: "cmdfb-\(next.messages.count)", role: .commandFeedback,
                    content: message, timestamp: ts,
                    args: ["command": .string(command), "status": .string(status)]))
            }

        case "subagent_created", "subagent_started", "subagent_completed", "subagent_failed":
            guard let id = data["id"]?.stringValue else { break }
            var sub = next.subagents[id] ?? SubagentState(
                id: id, type: data["type"]?.stringValue ?? "unknown",
                description: data["description"]?.stringValue ?? "", status: "created")
            switch event.eventType {
            case "subagent_started": sub.status = "running"
            case "subagent_completed":
                sub.status = "completed"; sub.result = data["result"]?.stringValue
            case "subagent_failed":
                sub.status = "failed"; sub.error = data["error"]?.stringValue
            default: sub.status = "created"
            }
            next.subagents[id] = sub

        case "turn_end":
            break

        default:
            // Unknown event → expandable raw JSON row (mirrors the reducer default).
            next.messages.append(ChatMessage(
                id: "raw-\(event.eventType)-\(Int(ts))-\(next.messages.count)", role: .rawEvent,
                content: ChatSessionState.prettyJSON(data), toolName: event.eventType, timestamp: ts))
        }

        return next
    }

    /// Fold a whole sequence (replay batch then live) in order.
    public func reduce<S: Sequence>(events: S) -> ChatSessionState where S.Element == DashboardEvent {
        events.reduce(self) { $0.reduce($1) }
    }

    // ── helpers ──

    private func messageRole(_ data: [String: JSONValue]) -> String? {
        data["message"]?.objectValue?["role"]?.stringValue
    }

    /// Pull `{ text, images }` out of a message payload whose `content` is either a
    /// string or an array of `{type:"text"|"image", …}` blocks (pi SDK shape).
    static func extractMessageTextAndImages(_ message: JSONValue?) -> (String, [ImageContent]) {
        guard let msg = message?.objectValue, let content = msg["content"] else { return ("", []) }
        if let s = content.stringValue { return (s, []) }
        guard let blocks = content.arrayValue else { return ("", []) }
        var text = ""
        var images: [ImageContent] = []
        for block in blocks {
            guard let obj = block.objectValue, let type = obj["type"]?.stringValue else { continue }
            if type == "text", let t = obj["text"]?.stringValue {
                text += t
            } else if type == "image", let d = obj["data"]?.stringValue, let m = obj["mimeType"]?.stringValue {
                images.append(ImageContent(data: d, mimeType: m))
            }
        }
        return (text, images)
    }

    /// Extract pre-resolved `[{data,mimeType}]` image arrays (state-replay shape).
    static func extractImages(_ value: JSONValue?) -> [ImageContent]? {
        guard let arr = value?.arrayValue, !arr.isEmpty else { return nil }
        let imgs = arr.compactMap { v -> ImageContent? in
            guard let o = v.objectValue, let d = o["data"]?.stringValue,
                  let m = o["mimeType"]?.stringValue else { return nil }
            return ImageContent(data: d, mimeType: m)
        }
        return imgs.isEmpty ? nil : imgs
    }

    /// Render an arbitrary JSON value to a display string (mirrors `toDisplayString`):
    /// strings pass through; content-block arrays/objects extract their text; other
    /// shapes pretty-print.
    static func displayString(_ value: JSONValue?) -> String? {
        guard let value = value else { return nil }
        switch value {
        case .null: return nil
        case .string(let s): return s
        case .number(let n): return n == n.rounded() ? String(Int(n)) : String(n)
        case .bool(let b): return b ? "true" : "false"
        case .array(let blocks):
            if let t = extractContentBlockText(blocks) { return t }
            return prettyJSON(value)
        case .object(let obj):
            if let blocks = obj["content"]?.arrayValue, let t = extractContentBlockText(blocks) { return t }
            return prettyJSON(value)
        }
    }

    private static func extractContentBlockText(_ blocks: [JSONValue]) -> String? {
        let texts = blocks.compactMap { b -> String? in
            guard let o = b.objectValue, o["type"]?.stringValue == "text" else { return nil }
            return o["text"]?.stringValue
        }
        return texts.isEmpty ? nil : texts.joined(separator: "\n")
    }

    static func truncateLines(_ text: String, _ maxLines: Int) -> String {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
        if lines.count <= maxLines { return text }
        return lines.prefix(maxLines).joined(separator: "\n")
    }

    static func prettyJSON(_ value: JSONValue) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(value),
              let s = String(data: data, encoding: .utf8) else { return "" }
        return s
    }

    static func prettyJSON(_ dict: [String: JSONValue]) -> String {
        prettyJSON(.object(dict))
    }
}
