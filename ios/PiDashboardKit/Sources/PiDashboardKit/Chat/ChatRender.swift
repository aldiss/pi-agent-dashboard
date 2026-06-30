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
}
