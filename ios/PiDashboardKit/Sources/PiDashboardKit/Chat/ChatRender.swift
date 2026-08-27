import Foundation

/// Pure, UI-free render helpers for the rich chat (Batch 1). The SwiftUI rendering
/// (MarkdownUI, expandable tool cards, lightbox) lives in the app target; the
/// deterministic bits — pretty-printing tool args, the thinking-collapse threshold,
/// the show-more truncation — live here so they're pinned by `swift test`.
public enum ChatRender {

    /// Pretty-print a tool call's `args` dictionary as indented JSON for the
    /// expanded tool-call detail. Stable key order (sorted) so the same args always
    /// render identically. Empty dict → "" (caller hides the section).
    public static func prettyArgs(_ args: [String: JSONValue]) -> String {
        if args.isEmpty { return "" }
        return ChatSessionState.prettyJSON(args)
    }

    /// PWA-equivalent collapsed tool summary. Arguments stay available in full when
    /// expanded; the header names the command/path/pattern so tool rows are useful at
    /// a glance instead of every read/bash/edit collapsing to the same word.
    public static func toolSummary(_ toolName: String, args: [String: JSONValue]) -> String {
        func value(_ key: String, fallback: String = "") -> String {
            guard let raw = args[key], let text = ChatSessionState.displayString(raw) else { return fallback }
            return text
        }
        func clipped(_ text: String, _ limit: Int) -> String { String(text.prefix(limit)) }

        switch toolName {
        case "read": return "Read \(value("path", fallback: "file"))"
        case "bash": return "$ \(clipped(value("command"), 60))"
        case "edit": return "Edit \(value("path", fallback: "file"))"
        case "write": return "Write \(value("path", fallback: "file"))"
        case "grep": return "Grep \(value("pattern"))"
        case "find": return "Find \(value("glob"))"
        case "ls": return "ls \(value("path", fallback: "."))"
        case "ask_user": return clipped(value("title", fallback: "ask_user"), 80)
        case "Agent":
            return "\(value("subagent_type", fallback: "Agent")): \(clipped(value("description"), 60))"
        case "get_subagent_result": return "Get result: \(clipped(value("agent_id"), 30))"
        case "steer_subagent": return "Steer: \(clipped(value("agent_id"), 30))"
        default: return toolName
        }
    }

    /// Thinking blocks longer than this (characters) default to COLLAPSED — a short
    /// aside stays open, a long chain-of-thought is tucked behind the chevron.
    public static let thinkingCollapseThreshold = 280

    /// Whether a thinking block should default to collapsed (long content).
    public static func shouldCollapseThinking(_ text: String) -> Bool {
        text.count > thinkingCollapseThreshold
    }

    /// Truncate a tool result / long block to `maxLines`, returning the visible text
    /// and whether it was clipped (drives the "show more" affordance). Pure.
    public static func truncated(_ text: String, maxLines: Int) -> (text: String, clipped: Bool) {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
        if lines.count <= maxLines { return (text, false) }
        return (lines.prefix(maxLines).joined(separator: "\n"), true)
    }

    /// Short sender label for a chat row's header marker ("● You" / "● Assistant" …) —
    /// the cue that makes each message a visibly distinct block (round 3.3). Mirrors the
    /// PWA's role separation. `turnSeparator` has no sender → nil.
    public static func senderLabel(for role: ChatRole) -> String? {
        switch role {
        case .user:            return "You"
        case .assistant:       return "Assistant"
        case .thinking:        return "Thinking"
        case .toolResult:      return "Tool"
        case .bashOutput:      return "Terminal"
        case .commandFeedback: return "Command"
        case .rawEvent:        return "Event"
        case .turnSeparator:   return nil
        }
    }

    /// Whether a row renders the lightweight sender header (dot + label). ONLY the prose
    /// rows (user / assistant) get it — they otherwise float with no role cue (the "wall
    /// of text" root cause). The card rows (tool / thinking / bash / command / raw)
    /// already carry an icon+name header that IS their marker, so a second label would
    /// be redundant noise. `turnSeparator` is its own break. Pure.
    public static func showsSenderHeader(for role: ChatRole) -> Bool {
        role == .user || role == .assistant
    }
}
