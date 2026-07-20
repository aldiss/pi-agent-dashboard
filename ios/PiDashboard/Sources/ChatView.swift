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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Distance (pt) of the bottom sentinel below the viewport bottom: ~0 when the
    /// chat is scrolled to the bottom, larger when the operator has scrolled up.
    /// Gates the non-animated auto-follow so a manual scroll-up isn't yanked back.
    @State private var bottomDistance: CGFloat = 0
    @State private var showModelPicker = false
    @State private var lightboxImage: UIImage?
    @State private var showAbortConfirm = false
    /// Active message-type filter for this session (per-session override → app
    /// default → canonical). Loaded on appear, persisted per session on change.
    @State private var messageFilter: MessageFilter = .default
    /// Whether the 6-pill filter controls row is expanded under the header.
    @State private var showFilterControls = false
    /// Perf (DF#5): render only the most-recent window of history until the operator
    /// taps "Load earlier". A large session shows ~175 rows on open, not thousands.
    @State private var showAllHistory = false
    /// Read-position + unread anchors captured AT OPEN (DF#3) — the divider + restore
    /// target stay stable while reading; live messages don't move them.
    @State private var unreadSummary: UnreadCounter.Summary = .none
    /// Guards the one-time restore-on-open scroll (replaces auto-scroll-to-end).
    @State private var didRestore = false

    private var state: ChatSessionState { store.chatState(sessionId) }
    private var session: DashboardSession? { store.sessions[sessionId] }

    /// The rows actually rendered: the reduced messages passed through the active
    /// message-type filter (tool spam / thinking / raw lifecycle hidden by default).
    private var filteredMessages: [ChatMessage] {
        MessageClassifier.filter(state.messages, messageFilter)
    }

    /// The windowed slice actually mounted (DF#5): tail ~175 until "Load earlier".
    private var windowed: ChatWindow.Windowed {
        ChatWindow.window(filteredMessages, showAll: showAllHistory)
    }

    var body: some View {
        VStack(spacing: 0) {
            sendFailureBanner
            if showFilterControls {
                MessageFilterControls(
                    filter: messageFilter,
                    counts: MessageClassifier.counts(state.messages),
                    onChange: updateFilter,
                    onReset: { updateFilter(.default) },
                    onSetDefault: { MessageFilterStore.saveDefault(messageFilter) })
            }
            messages
            queuedCards
            AdaptiveComposer(
                isWorking: state.isStreaming,
                queuedCount: state.activeQueuedCount,
                serverBase: store.connectedBase,
                serverToken: nil,
                serverCookie: store.connectionCookie,
                onSend: { text, images in
                    Task { await store.sendPrompt(sessionId, text: text, images: images.isEmpty ? nil : images) }
                },
                onStop: { Task { await store.abort(sessionId) } },
                initialText: store.composerOverflowText(for: sessionId))
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
                                .accessibilityHidden(true) // decorative disclosure glyph
                        }
                    }
                }
                .accessibilityIdentifier("chat-model-button")
                .accessibilityLabel("Model: \(session.flatMap(Format.modelLabel) ?? "not selected")")
                .accessibilityHint("Change the model")
            }
            filterToolbarItem
            abortToolbarItem
        }
        .confirmationDialog("Stop this session?", isPresented: $showAbortConfirm, titleVisibility: .visible) {
            Button("Stop session", role: .destructive) {
                Task { await store.abort(sessionId) }
            }
            .accessibilityIdentifier("chat-abort-confirm")
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The agent will stop its current turn.")
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
        .task {
            messageFilter = MessageFilterStore.load(sessionId)
            // Capture the read position + unread anchors AT OPEN, so the divider is
            // stable while reading (new live messages don't shove it around).
            unreadSummary = UnreadCounter.summarize(filteredMessages, lastReadId: store.lastReadId(sessionId))
            await store.openSession(sessionId)
        }
        .onDisappear {
            // The operator has seen this session → mark the newest rendered row read
            // so re-opening restores here (and the card's unread-asks badge clears).
            if let lastId = filteredMessages.last?.id { store.markRead(sessionId, messageId: lastId) }
            Task { await store.closeSession(sessionId) }
        }
    }

    /// Apply a new filter: update local state + persist the per-session override.
    private func updateFilter(_ next: MessageFilter) {
        messageFilter = next
        MessageFilterStore.save(sessionId, next)
    }

    /// Leading toolbar button toggling the message-type filter pill row. A dot badge
    /// marks a non-default (active) filter so the operator knows rows are hidden.
    @ToolbarContentBuilder private var filterToolbarItem: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            Button {
                withAnimation(Motion.animation(Motion.smooth, reduceMotion: reduceMotion)) { showFilterControls.toggle() }
            } label: {
                Image(systemName: messageFilter.isDefault
                      ? "line.3.horizontal.decrease.circle"
                      : "line.3.horizontal.decrease.circle.fill")
                    .foregroundStyle(messageFilter.isDefault ? theme.textSecondary : theme.accentBlue)
            }
            .accessibilityIdentifier("chat-filter-button")
            .accessibilityLabel("Message filter")
            .accessibilityValue(messageFilter.isDefault ? "default" : "active")
        }
    }

    /// Shown when a filter has hidden every row (all messages fell into OFF
    /// categories) — distinguishes "nothing to show yet" from "filtered out".
    private var filteredEmptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "line.3.horizontal.decrease.circle")
                .font(.largeTitle).foregroundStyle(theme.textTertiary)
            Text("All messages hidden by the filter")
                .font(.callout).foregroundStyle(theme.textSecondary)
            Button("Reset filter") { updateFilter(.default) }
                .font(.caption.weight(.semibold))
                .foregroundStyle(theme.accentBlue)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 60)
        .accessibilityIdentifier("chat-filter-empty")
    }

    /// "Load earlier" header shown above the windowed rows when older history is
    /// clipped (DF#5). Tapping reveals the full transcript for this session view.
    private func loadEarlierHeader(_ hidden: Int) -> some View {
        Button {
            showAllHistory = true
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "arrow.up.circle")
                Text("Load earlier (\(hidden))")
            }
            .font(.caption.weight(.medium))
            .foregroundStyle(theme.accentBlue)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
            .background(theme.bgTertiary.opacity(0.6))
            .clipShape(Capsule())
        }
        .buttonStyle(.pressable)
        .accessibilityIdentifier("chat-load-earlier")
    }

    /// Wrap the optional lightbox UIImage as an Identifiable item for `fullScreenCover(item:)`.
    private var lightboxItem: Binding<LightboxItem?> {
        Binding(
            get: { lightboxImage.map(LightboxItem.init) },
            set: { if $0 == nil { lightboxImage = nil } })
    }

    /// True when the session is doing work the operator can stop (streaming or
    /// active) — gates the Stop control's visibility.
    private var isRunning: Bool {
        let st = session?.status
        return st == "streaming" || st == "active"
    }

    /// Stop control — the app's first control action. Trailing toolbar button shown
    /// ONLY while the session is running; tap → confirmation → `store.abort`. Reflects
    /// the optimistic "Stopping…" state until the server confirms the stop.
    @ToolbarContentBuilder private var abortToolbarItem: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            if store.isAborting(sessionId) {
                HStack(spacing: 4) {
                    ProgressView().controlSize(.mini).tint(theme.accentRed)
                    Text("Stopping…").font(.caption2).foregroundStyle(theme.accentRed)
                }
                .accessibilityIdentifier("chat-abort-pending")
            } else if isRunning {
                Button(role: .destructive) {
                    showAbortConfirm = true
                } label: {
                    Label("Stop", systemImage: "stop.circle")
                        .foregroundStyle(theme.accentRed)
                }
                .accessibilityIdentifier("chat-abort-button")
            }
        }
    }

    private var messages: some View {
        GeometryReader { outer in
            ScrollViewReader { proxy in
                ScrollView {
                    // Spacing 16 (was 10) so messages don't crowd — with the sender
                    // headers + assistant card (round 3.3) each row reads as a block.
                    LazyVStack(alignment: .leading, spacing: 16) {
                        if state.messages.isEmpty {
                            emptyState
                        } else if filteredMessages.isEmpty {
                            filteredEmptyState
                        } else {
                            if windowed.hiddenCount > 0 {
                                loadEarlierHeader(windowed.hiddenCount)
                            }
                            ForEach(windowed.rows) { message in
                                if message.id == unreadSummary.firstUnreadId
                                    && unreadSummary.firstUnreadId != windowed.rows.first?.id {
                                    unreadDivider
                                }
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
                // DF#3: NO auto-scroll-to-end. On open, restore to the last-read row
                // (or the first unread / bottom) exactly once — never jump to the end.
                .accessibilityIdentifier("chat-scroll")
                .onAppear { restoreOnOpen(proxy) }
                .onPreferenceChange(BottomDistanceKey.self) { sentinelMinY in
                    // distance the sentinel sits BELOW the viewport bottom: ~0 (or
                    // negative) when scrolled to the bottom, grows as the operator
                    // scrolls up. Viewport height = outer.size.height.
                    bottomDistance = sentinelMinY - outer.size.height
                    // At the bottom → the operator has read to the newest row; mark it
                    // read live so the unread badge clears without waiting for close.
                    if bottomDistance <= Self.nearBottomThreshold, let lastId = filteredMessages.last?.id {
                        store.markRead(sessionId, messageId: lastId)
                    }
                }
                // Non-animated auto-follow (NO animation — animation was the jitter
                // source). Fires on new rows AND on streamingText growth, but ONLY
                // when already near the bottom, so a manual scroll-up to read history
                // is never fought (and NEVER on open — see restoreOnOpen).
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

    /// Restore-on-open (DF#3): scroll to the last-read row → else the first unread →
    /// else the bottom. Runs ONCE. Replaces the old auto-scroll-to-end so re-opening a
    /// session returns the operator to where they left off, not the newest message.
    private func restoreOnOpen(_ proxy: ScrollViewProxy) {
        guard !didRestore else { return }
        didRestore = true
        let target = store.lastReadId(sessionId) ?? unreadSummary.firstUnreadId
        // Wait a beat for the LazyVStack to realize rows, then anchor without animation.
        DispatchQueue.main.async {
            if let target, windowed.rows.contains(where: { $0.id == target }) {
                proxy.scrollTo(target, anchor: .top)
            } else {
                proxy.scrollTo("chat-bottom", anchor: .bottom)
            }
        }
    }

    /// "N unread" divider (DF#3, Telegram-style) rendered above the first unread row.
    private var unreadDivider: some View {
        HStack(spacing: 8) {
            Rectangle().fill(theme.statusUnread.opacity(0.5)).frame(height: 1)
            Text(unreadSummary.tierAUnread > 0
                 ? "\(unreadSummary.tierAUnread) unread \(unreadSummary.tierAUnread == 1 ? "ask" : "asks")"
                 : "unread")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(theme.statusUnread)
                .fixedSize()
            Rectangle().fill(theme.statusUnread.opacity(0.5)).frame(height: 1)
        }
        .padding(.vertical, 2)
        .accessibilityIdentifier("chat-unread-divider")
    }

    @ViewBuilder private var streamingIndicator: some View {
        switch state.streamingIndicator {
        case .hidden:
            EmptyView()
        case .text:
            // The answer is arriving — its growth alone signals "alive"; no timer.
            MarkdownText(content: state.streamingText)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .tool(let tool):
            workingRow(label: "running \(tool)…")
        case .thinking(let reasoning):
            // Live reasoning: the spinner+elapsed header PLUS the reasoning text as it
            // streams (muted/italic, like a ThinkingBlock) so the operator SEES it move.
            VStack(alignment: .leading, spacing: 4) {
                workingRow(label: "thinking…")
                Text(reasoning)
                    .font(.caption)
                    .italic()
                    .foregroundStyle(theme.textTertiary)
                    .lineLimit(6)
                    .truncationMode(.head) // keep the LATEST reasoning visible as it grows
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("chat-streaming-thinking")
            }
        case .waiting:
            workingRow(label: "thinking…")
        }
    }

    /// A working-state row: spinner + label + a live elapsed timer ("thinking… 0:45" /
    /// "running bash… 0:12") ticking every second from the agent-run start. The timer
    /// is what tells ALIVE from hung on a long turn. Cleared when streaming ends
    /// (`agent_end` → `streamingIndicator == .hidden`, this view is gone).
    private func workingRow(label: String) -> some View {
        HStack(spacing: 6) {
            ProgressView().controlSize(.small).tint(theme.textTertiary)
            Text(label).font(.caption).foregroundStyle(theme.textTertiary)
            if let started = state.streamingStartedAt {
                TimelineView(.periodic(from: .now, by: 1)) { _ in
                    // Guarded: a missing / 0 / absurdly-old anchor (a session already
                    // streaming when the app opens, before a fresh turn_start resets it)
                    // yields nil → render just the label, never a garbage "45637:13".
                    if let elapsed = TimeFormat.elapsedClockOrNil(
                        fromEpochMs: started,
                        now: Date().timeIntervalSince1970 * 1000
                    ) {
                        Text(elapsed)
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(theme.textTertiary)
                            .accessibilityIdentifier("chat-streaming-elapsed")
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
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
