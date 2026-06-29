import SwiftUI
import PiDashboardKit

/// Renders one reduced chat row by role. Mirrors the PWA chat's message kinds:
/// user/assistant bubbles (markdown), thinking, tool call+result, bash output,
/// turn separators, raw events. Identifier `chat-message-<id>` per TEST-CONTRACT.
struct ChatMessageRow: View {
    let message: ChatMessage
    @Environment(\.theme) private var theme

    var body: some View {
        content
            .frame(maxWidth: .infinity, alignment: alignment)
            .accessibilityIdentifier("chat-message-\(message.id)")
    }

    private var alignment: Alignment { message.role == .user ? .trailing : .leading }

    @ViewBuilder private var content: some View {
        switch message.role {
        case .user:            userBubble
        case .assistant:       assistantText
        case .thinking:        thinkingBlock
        case .toolResult:      toolCard
        case .bashOutput:      bashCard
        case .commandFeedback: commandFeedbackRow
        case .turnSeparator:   Divider().overlay(theme.borderSecondary).padding(.vertical, 2)
        case .rawEvent:        rawCard
        }
    }

    private var userBubble: some View {
        VStack(alignment: .trailing, spacing: 6) {
            if !message.images.isEmpty { imageStrip }
            if !message.content.isEmpty {
                Text(message.content)
                    .font(.callout)
                    .foregroundStyle(theme.textPrimary)
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .background(theme.bgSurface)
                    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            }
        }
        .frame(maxWidth: 300, alignment: .trailing)
    }

    private var assistantText: some View {
        markdown(message.content)
            .font(.callout)
            .foregroundStyle(theme.textPrimary)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var thinkingBlock: some View {
        VStack(alignment: .leading, spacing: 4) {
            Label("Thinking", systemImage: "brain")
                .font(.caption2.weight(.medium))
                .foregroundStyle(theme.textTertiary)
            Text(message.content)
                .font(.caption)
                .foregroundStyle(theme.textTertiary)
                .italic()
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme.bgSecondary)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private var toolCard: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: toolIcon).font(.caption)
                Text(message.toolName ?? "tool").font(.caption.weight(.semibold)).monospaced()
                Spacer()
                toolStatusBadge
                if let d = message.duration, d > 0 {
                    Text("\(Int(d / 1000))s").font(.caption2).foregroundStyle(theme.textTertiary)
                }
            }
            .foregroundStyle(theme.textSecondary)
            if let result = message.result, !result.isEmpty {
                Text(result)
                    .font(.caption.monospaced())
                    .foregroundStyle(theme.textSecondary)
                    .lineLimit(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
                    .background(theme.bgCode)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
            if !message.images.isEmpty { imageStrip }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme.bgSecondary)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(theme.borderPrimary, lineWidth: 1))
    }

    private var bashCard: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let cmd = message.args["command"]?.stringValue {
                Text("$ \(cmd)").font(.caption.monospaced()).foregroundStyle(theme.accentGreen)
            }
            Text(message.content)
                .font(.caption.monospaced())
                .foregroundStyle(theme.textSecondary)
                .lineLimit(16)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme.bgCode)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private var commandFeedbackRow: some View {
        HStack(spacing: 6) {
            Image(systemName: "terminal").font(.caption2)
            Text(message.args["command"]?.stringValue ?? "").font(.caption.monospaced())
            if !message.content.isEmpty {
                Text("· \(message.content)").font(.caption2).foregroundStyle(theme.textTertiary)
            }
        }
        .foregroundStyle(theme.textSecondary)
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(theme.bgSecondary)
        .clipShape(Capsule())
    }

    private var rawCard: some View {
        DisclosureGroup {
            Text(message.content)
                .font(.caption2.monospaced())
                .foregroundStyle(theme.textTertiary)
                .frame(maxWidth: .infinity, alignment: .leading)
        } label: {
            Text(message.toolName ?? "event")
                .font(.caption2.weight(.medium))
                .foregroundStyle(theme.textTertiary)
        }
        .padding(8)
        .background(theme.bgSecondary)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private var imageStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(Array(message.images.enumerated()), id: \.offset) { _, img in
                    if let data = Data(base64Encoded: img.data), let ui = UIImage(data: data) {
                        Image(uiImage: ui)
                            .resizable().scaledToFill()
                            .frame(width: 120, height: 120)
                            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    }
                }
            }
        }
    }

    private var toolStatusBadge: some View {
        Group {
            switch message.toolStatus {
            case .running: Image(systemName: "circle.dotted").foregroundStyle(theme.accentBlue)
            case .complete: Image(systemName: "checkmark.circle.fill").foregroundStyle(theme.accentGreen)
            case .error: Image(systemName: "xmark.circle.fill").foregroundStyle(theme.accentRed)
            case .none: EmptyView()
            }
        }
        .font(.caption2)
    }

    private var toolIcon: String {
        switch message.toolName?.lowercased() {
        case "bash": return "terminal"
        case "read": return "doc.text"
        case "write", "edit": return "pencil"
        case "grep", "glob": return "magnifyingglass"
        default: return "wrench.and.screwdriver"
        }
    }

    /// Markdown when it parses; plain text otherwise (assistant prose is markdown
    /// in the PWA). Uses SwiftUI's built-in `AttributedString(markdown:)`.
    @ViewBuilder private func markdown(_ text: String) -> some View {
        if let attributed = try? AttributedString(
            markdown: text,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)) {
            Text(attributed)
        } else {
            Text(text)
        }
    }
}
