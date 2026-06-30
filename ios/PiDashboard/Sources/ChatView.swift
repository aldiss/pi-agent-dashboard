import SwiftUI
import PiDashboardKit

/// Session detail / chat. On appear: subscribe + session_view (via the store); on
/// disappear: session_unview. Renders the reduced event stream + the composer.
/// Identifiers: chat-scroll / chat-message-<id> / chat-empty (TEST-CONTRACT §A).
struct ChatView: View {
    let sessionId: String
    let title: String

    @Environment(DashboardStore.self) private var store
    @Environment(\.theme) private var theme

    private var state: ChatSessionState { store.chatState(sessionId) }
    private var session: DashboardSession? { store.sessions[sessionId] }

    var body: some View {
        VStack(spacing: 0) {
            sendFailureBanner
            messages
            AdaptiveComposer(
                isWorking: state.isStreaming,
                queuedCount: 0,
                serverBase: store.connectedBase,
                serverToken: store.connectionToken,
                onSend: { text, images in
                    Task { await store.sendPrompt(sessionId, text: text, images: images.isEmpty ? nil : images) }
                },
                onStop: { Task { await store.abort(sessionId) } })
        }
        .background(theme.bgPrimary)
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 1) {
                    Text(title).font(.headline).foregroundStyle(theme.textPrimary).lineLimit(1)
                    if let model = session.flatMap(Format.modelLabel) {
                        Text(model).font(.caption2).foregroundStyle(theme.textTertiary)
                    }
                }
            }
        }
        .task { await store.openSession(sessionId) }
        .onDisappear { Task { await store.closeSession(sessionId) } }
    }

    private var messages: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    if state.messages.isEmpty {
                        emptyState
                    } else {
                        ForEach(state.messages) { message in
                            ChatMessageRow(message: message).id(message.id)
                        }
                        if state.isStreaming { streamingIndicator }
                        Color.clear.frame(height: 1).id("chat-bottom")
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 12)
            }
            .accessibilityIdentifier("chat-scroll")
            .onChange(of: state.messages.count) { _, _ in
                withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("chat-bottom", anchor: .bottom) }
            }
        }
    }

    @ViewBuilder private var streamingIndicator: some View {
        if !state.streamingText.isEmpty {
            Text(state.streamingText)
                .font(.callout)
                .foregroundStyle(theme.textPrimary)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            HStack(spacing: 6) {
                ProgressView().controlSize(.small).tint(theme.textTertiary)
                if let tool = state.currentTool {
                    Text("running \(tool)…").font(.caption).foregroundStyle(theme.textTertiary)
                } else {
                    Text("thinking…").font(.caption).foregroundStyle(theme.textTertiary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            ProgressView().tint(theme.textTertiary)
            Text("Loading session…").font(.caption).foregroundStyle(theme.textTertiary)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 80)
        .accessibilityIdentifier("chat-empty")
    }

    @ViewBuilder private var sendFailureBanner: some View {
        if let reason = store.sendFailures[sessionId] {
            HStack(spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill")
                Text(reason).font(.caption)
                Spacer()
            }
            .foregroundStyle(theme.accentRed)
            .padding(10)
            .background(theme.accentRed.opacity(0.12))
        }
    }
}
