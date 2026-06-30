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

    /// Distance (pt) of the bottom sentinel below the viewport bottom: ~0 when the
    /// chat is scrolled to the bottom, larger when the operator has scrolled up.
    /// Gates the non-animated auto-follow so a manual scroll-up isn't yanked back.
    @State private var bottomDistance: CGFloat = 0
    @State private var showModelPicker = false
    @State private var lightboxImage: UIImage?

    private var state: ChatSessionState { store.chatState(sessionId) }
    private var session: DashboardSession? { store.sessions[sessionId] }

    var body: some View {
        VStack(spacing: 0) {
            sendFailureBanner
            messages
            queuedCards
            AdaptiveComposer(
                isWorking: state.isStreaming,
                queuedCount: state.activeQueuedCount,
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
                Button { showModelPicker = true } label: {
                    VStack(spacing: 1) {
                        Text(title).font(.headline).foregroundStyle(theme.textPrimary).lineLimit(1)
                        HStack(spacing: 3) {
                            Text(session.flatMap(Format.modelLabel) ?? "Select model")
                                .font(.caption2).foregroundStyle(theme.textTertiary)
                            Image(systemName: "chevron.down")
                                .font(.system(size: 8, weight: .semibold))
                                .foregroundStyle(theme.textTertiary)
                        }
                    }
                }
                .accessibilityIdentifier("chat-model-button")
            }
        }
        .sheet(isPresented: $showModelPicker) {
            ModelPickerSheet(sessionId: sessionId)
                .environment(store)
                .environment(\.theme, theme)
                .presentationDetents([.medium, .large])
        }
        .fullScreenCover(item: lightboxItem) { item in
            ImageLightbox(image: item.image) { lightboxImage = nil }
                .background(BackdropClearBackground())
        }
        .task { await store.openSession(sessionId) }
        .onDisappear { Task { await store.closeSession(sessionId) } }
    }

    /// Wrap the optional lightbox UIImage as an Identifiable item for `fullScreenCover(item:)`.
    private var lightboxItem: Binding<LightboxItem?> {
        Binding(
            get: { lightboxImage.map(LightboxItem.init) },
            set: { if $0 == nil { lightboxImage = nil } })
    }

    private var messages: some View {
        GeometryReader { outer in
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        if state.messages.isEmpty {
                            emptyState
                        } else {
                            ForEach(state.messages) { message in
                                ChatMessageRow(message: message) { ui in lightboxImage = ui }
                                    .id(message.id)
                            }
                            if state.isStreaming { streamingIndicator }
                            // Bottom sentinel: zero-height scroll anchor + a geometry
                            // probe reporting its position in the fixed viewport space.
                            Color.clear
                                .frame(height: 1)
                                .id("chat-bottom")
                                .background(
                                    GeometryReader { geo in
                                        Color.clear.preference(
                                            key: BottomDistanceKey.self,
                                            value: geo.frame(in: .named("chat-viewport")).minY)
                                    }
                                )
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 12)
                }
                // Naturally stick to the bottom as content (incl. streamingText) grows
                // — the calm replacement for the old animated scrollTo. The anchor
                // holds the bottom on content-size changes without re-firing per row.
                .defaultScrollAnchor(.bottom)
                .accessibilityIdentifier("chat-scroll")
                .onPreferenceChange(BottomDistanceKey.self) { sentinelMinY in
                    // distance the sentinel sits BELOW the viewport bottom: ~0 (or
                    // negative) when scrolled to the bottom, grows as the operator
                    // scrolls up. Viewport height = outer.size.height.
                    bottomDistance = sentinelMinY - outer.size.height
                }
                // Non-animated auto-follow (NO animation — animation was the jitter
                // source). Fires on new rows AND on streamingText growth, but ONLY
                // when already near the bottom, so a manual scroll-up to read history
                // is never fought.
                .onChange(of: state.messages.count) { _, _ in autoFollow(proxy) }
                .onChange(of: state.streamingText) { _, _ in autoFollow(proxy) }
            }
            .coordinateSpace(name: "chat-viewport")
        }
    }

    /// Distance (pt) the bottom sentinel sits below the viewport bottom edge: ~0 at
    /// the bottom, larger when scrolled up. Within this band counts as "near bottom".
    private static let nearBottomThreshold: CGFloat = 160

    /// Pin to the bottom WITHOUT animation, but only when the operator is already
    /// near the bottom. The sentinel also de-realizes when scrolled far up
    /// (LazyVStack), so the follow naturally stays off there too.
    private func autoFollow(_ proxy: ScrollViewProxy) {
        guard !state.messages.isEmpty else { return }
        guard bottomDistance <= Self.nearBottomThreshold else { return }
        proxy.scrollTo("chat-bottom", anchor: .bottom)
    }

    @ViewBuilder private var streamingIndicator: some View {
        if !state.streamingText.isEmpty {
            MarkdownText(content: state.streamingText)
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

    /// Compact list of queued follow-ups just above the composer (muted, with a
    /// queue glyph) so the operator sees what's waiting for the agent's next turn.
    /// Failed entries show a tap-to-retry. Mirrors the PWA queued-card style.
    @ViewBuilder private var queuedCards: some View {
        if !state.queued.isEmpty {
            VStack(spacing: 4) {
                ForEach(state.queued) { q in
                    HStack(spacing: 8) {
                        Image(systemName: q.status == .failed ? "exclamationmark.circle.fill" : "clock.arrow.circlepath")
                            .font(.caption2)
                            .foregroundStyle(q.status == .failed ? theme.accentRed : theme.textTertiary)
                        Text(q.text)
                            .font(.caption)
                            .foregroundStyle(theme.textSecondary)
                            .lineLimit(1)
                        Spacer(minLength: 4)
                        if q.status == .failed {
                            Button("Retry") {
                                Task { await store.retryQueued(sessionId, nonce: q.queueNonce) }
                            }
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(theme.accentBlue)
                        } else {
                            Text(q.source == .tui ? "queued · tui" : "queued")
                                .font(.caption2)
                                .foregroundStyle(theme.textTertiary)
                        }
                    }
                    .padding(.horizontal, 12).padding(.vertical, 6)
                    .background(theme.bgTertiary.opacity(0.6))
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .accessibilityIdentifier("chat-queued-\(q.queueNonce)")
                }
            }
            .padding(.horizontal, 8)
            .padding(.bottom, 4)
        }
    }
}

/// Carries the bottom sentinel's `minY` (in the fixed viewport coordinate space) up
/// to `ChatView`, which derives `bottomDistance` to gate the non-animated
/// auto-follow. `reduce` keeps the last (deepest) value reported in a layout pass.
private struct BottomDistanceKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}

/// Identifiable wrapper so a tapped `UIImage` can drive `fullScreenCover(item:)`.
private struct LightboxItem: Identifiable {
    let image: UIImage
    let id = UUID()
}

/// Clears the system `fullScreenCover` white backdrop so the lightbox's own dark
/// backdrop shows edge-to-edge (the cover host view is made transparent).
private struct BackdropClearBackground: UIViewRepresentable {
    func makeUIView(context: Context) -> UIView {
        let v = UIView()
        DispatchQueue.main.async { v.superview?.superview?.backgroundColor = .clear }
        return v
    }
    func updateUIView(_ uiView: UIView, context: Context) {}
}
