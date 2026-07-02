import SwiftUI
import PiDashboardKit

/// Renders one reduced chat row by role — Batch 1 rich rendering: markdown prose
/// (MarkdownUI), expandable tool-call detail (args JSON + result), collapsible
/// thinking, inline images with tap-to-zoom (lightbox owned by `ChatView`).
/// Identifier `chat-message-<id>` per TEST-CONTRACT.
struct ChatMessageRow: View {
    let message: ChatMessage
    /// Tapping an inline image asks `ChatView` to present the full-screen lightbox.
    var onImageTap: (UIImage) -> Void = { _ in }
    @Environment(\.theme) private var theme

    @State private var toolExpanded = false
    @State private var resultExpanded = false
    @State private var thinkingExpanded: Bool

    init(message: ChatMessage, onImageTap: @escaping (UIImage) -> Void = { _ in }) {
        self.message = message
        self.onImageTap = onImageTap
        // Long thinking starts collapsed; a short aside stays open.
        _thinkingExpanded = State(initialValue: !ChatRender.shouldCollapseThinking(message.content))
    }

    var body: some View {
        Group {
            if message.role == .turnSeparator {
                content
            } else {
                VStack(alignment: stackAlignment, spacing: 3) {
                    if ChatRender.showsSenderHeader(for: message.role) { senderHeader }
                    content
                    timestampCaption
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: alignment)
        .accessibilityIdentifier("chat-message-\(message.id)")
    }

    private var alignment: Alignment { message.role == .user ? .trailing : .leading }
    private var stackAlignment: HorizontalAlignment { message.role == .user ? .trailing : .leading }

    /// Lightweight sender marker (accent dot + role label) that opens every prose row,
    /// so the eye sees where each message starts + who sent it (round 3.3 — the
    /// "wall of text" fix). User → blue + trailing; assistant → neutral + leading.
    @ViewBuilder private var senderHeader: some View {
        if let label = ChatRender.senderLabel(for: message.role) {
            HStack(spacing: 5) {
                Circle().fill(senderAccent).frame(width: 6, height: 6)
                Text(label)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(theme.textTertiary)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(label)
            .accessibilityIdentifier("chat-message-sender")
        }
    }

    /// Accent hue for the sender dot — user blue (matches the bubble accent), assistant
    /// a neutral secondary so it reads as a marker, not an alert.
    private var senderAccent: Color {
        message.role == .user ? theme.accentBlue : theme.textSecondary
    }

    @ViewBuilder private var timestampCaption: some View {
        let label = Format.clockTime(fromEpochMs: message.timestamp)
        if !label.isEmpty {
            Text(label)
                .font(.caption2)
                .foregroundStyle(theme.textTertiary)
                .padding(.horizontal, message.role == .user ? 4 : 2)
                .accessibilityIdentifier("chat-message-time")
        }
    }

    @ViewBuilder private var content: some View {
        switch message.role {
        case .user:            userBubble
        case .assistant:       assistantText
        case .thinking:        thinkingBlock
        case .toolResult:      toolCard
        case .bashOutput:      bashCard
        case .commandFeedback: commandFeedbackRow
        case .turnSeparator:   turnSeparatorBreak
        case .rawEvent:        rawCard
        }
    }

    /// A visible "new turn" break between agent turns — was a bare thin `Divider` that
    /// vanished into the wall of text. Now a spaced rule + centered caption (mirrors the
    /// unread divider) so a fresh turn reads as a new section.
    private var turnSeparatorBreak: some View {
        HStack(spacing: 8) {
            Rectangle().fill(theme.borderSecondary).frame(height: 1)
            Text("new turn")
                .font(.caption2.weight(.medium))
                .foregroundStyle(theme.textTertiary)
                .fixedSize()
            Rectangle().fill(theme.borderSecondary).frame(height: 1)
        }
        .padding(.vertical, 6)
        .accessibilityIdentifier("chat-turn-separator")
    }

    // MARK: user

    private var userBubble: some View {
        VStack(alignment: .trailing, spacing: 6) {
            if !message.images.isEmpty { imageStrip }
            if !message.content.isEmpty {
                MarkdownText(content: message.content)
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .background(theme.bgSurface)
                    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                            .stroke(theme.accentBlue.opacity(0.35), lineWidth: 1)
                    )
            }
            deliveryFooter
        }
        .frame(maxWidth: 320, alignment: .trailing)
    }

    @ViewBuilder private var deliveryFooter: some View {
        switch message.delivery {
        case .pending:
            HStack(spacing: 4) {
                ProgressView().controlSize(.mini).tint(theme.textTertiary)
                Text("Sending…").font(.caption2).foregroundStyle(theme.textTertiary)
            }
            .accessibilityIdentifier("chat-message-pending")
        case .failed:
            HStack(spacing: 4) {
                Image(systemName: "exclamationmark.circle.fill").font(.caption2)
                Text("Not sent").font(.caption2)
            }
            .foregroundStyle(theme.accentRed)
            .accessibilityIdentifier("chat-message-failed")
        case .confirmed, .none:
            EmptyView()
        }
    }

    // MARK: assistant (markdown)

    /// Assistant prose in a soft full-width card (mirrors the PWA `bg-tertiary` +
    /// subtle-border assistant bubble). Was BARE `MarkdownText` with no boundary — the
    /// root cause of consecutive assistant messages merging into one wall. The card +
    /// the sender header above now make each reply a distinct block.
    private var assistantText: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !message.content.isEmpty {
                MarkdownText(content: message.content)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if !message.images.isEmpty { imageStrip }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme.bgTertiary)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(theme.borderPrimary, lineWidth: 1)
        )
    }

    // MARK: thinking (collapsible)

    private var thinkingBlock: some View {
        HStack(spacing: 0) {
            // Purple leading rule — "reasoning" accent (PWA border-purple-500/30).
            Rectangle().fill(theme.accentPurple.opacity(0.5)).frame(width: 3)

            VStack(alignment: .leading, spacing: thinkingExpanded ? 6 : 0) {
                Button {
                    withAnimation(.easeInOut(duration: 0.18)) { thinkingExpanded.toggle() }
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "brain").foregroundStyle(theme.accentPurple)
                        Text("Thinking")
                        Spacer()
                        Image(systemName: thinkingExpanded ? "chevron.up" : "chevron.down")
                    }
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(theme.textTertiary)
                }
                .accessibilityIdentifier("chat-thinking-toggle")
                if thinkingExpanded {
                    Text(message.content)
                        .font(.caption)
                        .foregroundStyle(theme.textSecondary)
                        .italic()
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(10)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme.accentPurple.opacity(0.06))
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    // MARK: tool (expandable)

    private var toolCard: some View {
        HStack(spacing: 0) {
            // Leading rule — tool-status hue (running amber / done green / error red).
            Rectangle().fill(theme.toolStatusColor(message.toolStatus)).frame(width: 3)

            VStack(alignment: .leading, spacing: toolExpanded ? 8 : 0) {
                Button {
                    withAnimation(.easeInOut(duration: 0.18)) { toolExpanded.toggle() }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: toolIcon).font(.caption)
                            .foregroundStyle(theme.toolStatusColor(message.toolStatus))
                        Text(message.toolName ?? "tool").font(.caption.weight(.semibold)).monospaced()
                        Spacer()
                        toolStatusBadge
                        if let d = message.duration, d > 0 {
                            Text("\(Int(d / 1000))s").font(.caption2).foregroundStyle(theme.textTertiary)
                        }
                        Image(systemName: toolExpanded ? "chevron.up" : "chevron.down")
                            .font(.caption2)
                    }
                    .foregroundStyle(theme.textSecondary)
                }
                .accessibilityIdentifier("chat-tool-toggle")

                if toolExpanded {
                    let argsText = ChatRender.prettyArgs(message.args)
                    if !argsText.isEmpty {
                        sectionLabel("Input")
                        codeBox(argsText, lineLimit: nil)
                    }
                    if let result = message.result, !result.isEmpty {
                        sectionLabel("Output")
                        toolResultBox(result)
                    }
                    if !message.images.isEmpty { imageStrip }
                } else if let result = message.result, !result.isEmpty {
                    // Collapsed: a one-line peek at the result.
                    Text(result)
                        .font(.caption2.monospaced())
                        .foregroundStyle(theme.textTertiary)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.top, 4)
                }
            }
            .padding(10)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme.bgSecondary)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(theme.borderPrimary, lineWidth: 1))
    }

    private func sectionLabel(_ text: String) -> some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(theme.textTertiary)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func codeBox(_ text: String, lineLimit: Int?) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Text(text)
                .font(.caption.monospaced())
                .foregroundStyle(theme.textSecondary)
                .lineLimit(lineLimit)
                .padding(8)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme.bgCode)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    @ViewBuilder private func toolResultBox(_ result: String) -> some View {
        let (visible, clipped) = ChatRender.truncated(result, maxLines: 30)
        VStack(alignment: .leading, spacing: 4) {
            codeBox(resultExpanded ? result : visible, lineLimit: nil)
            if clipped {
                Button(resultExpanded ? "Show less" : "Show more") {
                    withAnimation(.easeInOut(duration: 0.15)) { resultExpanded.toggle() }
                }
                .font(.caption2.weight(.semibold))
                .foregroundStyle(theme.accentBlue)
                .accessibilityIdentifier("chat-tool-showmore")
            }
        }
    }

    // MARK: bash / command / raw

    private var bashCard: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let cmd = message.args["command"]?.stringValue {
                Text("$ \(cmd)").font(.caption.monospaced()).foregroundStyle(theme.accentGreen)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                Text(message.content)
                    .font(.caption.monospaced())
                    .foregroundStyle(theme.textSecondary)
                    .lineLimit(16)
            }
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
            ScrollView(.horizontal, showsIndicators: false) {
                Text(message.content)
                    .font(.caption2.monospaced())
                    .foregroundStyle(theme.textTertiary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        } label: {
            Text(message.toolName ?? "event")
                .font(.caption2.weight(.medium))
                .foregroundStyle(theme.textTertiary)
        }
        .padding(8)
        .background(theme.bgSecondary)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    // MARK: images

    private var imageStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(Array(message.images.enumerated()), id: \.offset) { _, img in
                    if let data = Data(base64Encoded: img.data), let ui = UIImage(data: data) {
                        Button { onImageTap(ui) } label: {
                            Image(uiImage: ui)
                                .resizable().scaledToFill()
                                .frame(width: 140, height: 140)
                                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                                .overlay(RoundedRectangle(cornerRadius: 10).stroke(theme.borderPrimary, lineWidth: 1))
                        }
                        .accessibilityIdentifier("chat-image")
                    }
                }
            }
        }
    }

    private var toolStatusBadge: some View {
        Group {
            switch message.toolStatus {
            case .running: Image(systemName: "circle.dotted").foregroundStyle(theme.toolStatusColor(.running))
            case .complete: Image(systemName: "checkmark.circle.fill").foregroundStyle(theme.toolStatusColor(.complete))
            case .error: Image(systemName: "xmark.circle.fill").foregroundStyle(theme.toolStatusColor(.error))
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
}
