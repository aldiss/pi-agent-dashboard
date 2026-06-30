import Foundation
import Observation
import PiDashboardKit

/// One tier section ready for the list: the tier + its directory subgroups.
struct TierSection: Identifiable {
    let tier: SessionTier
    let groups: [SessionGrouping.DirectoryGroup]
    var id: String { tier.rawValue }
}

/// The connection phase the banner reads. `.reconnecting` is the >3s-disconnect
/// state the PWA surfaces; `.connecting` is the first attempt (no banner).
enum ConnectionPhase: Equatable {
    case idle, connecting, connected, reconnecting, failed(String)
}

/// `@MainActor @Observable` store wrapping the core `DashboardClient`. Owns the
/// session registry + per-cwd order + pinned dirs, consumes the `ServerMessage`
/// stream applying snapshot/added/updated/removed/reordered/pinned, routes chat
/// events into per-session `ChatSessionState`, and drives reconnect/backoff +
/// the disconnect banner. The single source of truth the SwiftUI tree renders.
@MainActor
@Observable
final class DashboardStore {
    // Connection
    private(set) var phase: ConnectionPhase = .idle
    private(set) var health: HealthStatus?
    var serverURLString = "http://localhost:8000"
    var token = ""
    /// Set once a successful connect has entered the dashboard — keeps MainView
    /// mounted across transient drops (only the banner changes).
    private(set) var hasEnteredDashboard = false

    // Registry
    private(set) var sessions: [String: DashboardSession] = [:]
    private(set) var orders: [String: [String]] = [:]
    private(set) var pinnedDirectories: [String] = []

    // Filters (mirror the PWA toggles)
    var folders = true
    var hideStale = false
    var showHidden = false
    var staleHoursThreshold: Double = 12
    var search = ""

    // Chat
    private(set) var chatStates: [String: ChatSessionState] = [:]
    /// sessionId → last send failure reason (bridge absent), surfaced in ChatView.
    private(set) var sendFailures: [String: String] = [:]
    /// sessionId → available models (populated by `models_list` after requestModels).
    private(set) var availableModels: [String: [ModelInfo]] = [:]
    /// sessionId currently on screen — drives session_view/unview.
    private(set) var viewedSessionId: String?

    private let client = DashboardClient()
    private var consumeTask: Task<Void, Never>?
    private var base: URL?
    private var reconnectAttempt = 0
    private let isUITest: Bool

    /// The dashboard base URL the app is connected to (for building sidecar URLs
    /// like the parakeet voice endpoint). Falls back to the entered URL string so a
    /// `-uitest` fixture session (which skips the real `connect`) still resolves one.
    var connectedBase: URL? {
        base ?? URL(string: serverURLString.trimmingCharacters(in: .whitespaces))
    }
    /// The bearer token for the connected server, if any.
    var connectionToken: String? { token.isEmpty ? nil : token }

    init() {
        isUITest = ProcessInfo.processInfo.arguments.contains("-uitest")
    }

    // MARK: Connect

    /// Probe `/api/health` then open the WS. On UITest launch, load bundled
    /// fixtures instead of touching the network (hermetic, no live mutation).
    func connect() async {
        if isUITest { loadFixtures(); return }
        guard let url = URL(string: serverURLString.trimmingCharacters(in: .whitespaces)) else {
            phase = .failed("Invalid URL"); return
        }
        base = url
        phase = .connecting
        let rest = RestClient(base: url, token: token.isEmpty ? nil : token)
        do {
            let h = try await rest.health()
            guard h.ok else { phase = .failed("Server reported not-ok"); return }
            health = h
        } catch {
            phase = .failed("Unreachable — is the dashboard running?")
            return
        }
        startStream(base: url)
    }

    private func startStream(base: URL) {
        consumeTask?.cancel()
        let token = self.token
        consumeTask = Task { [weak self] in
            guard let self else { return }
            let stream = await self.client.connect(base: base, token: token.isEmpty ? nil : token)
            for await message in stream {
                if Task.isCancelled { return }
                self.apply(message)
            }
            // Stream finished → socket dropped. Reconnect with backoff unless torn down.
            if !Task.isCancelled { await self.scheduleReconnect(base: base) }
        }
    }

    private func scheduleReconnect(base: URL) async {
        guard hasEnteredDashboard else { phase = .failed("Disconnected"); return }
        phase = .reconnecting
        reconnectAttempt += 1
        let delay = min(pow(2.0, Double(reconnectAttempt)), 30) // 2,4,8,…cap 30s
        try? await Task.sleep(for: .seconds(delay))
        if Task.isCancelled { return }
        startStream(base: base)
        // Re-subscribe to the on-screen session after a reconnect.
        if let sid = viewedSessionId { await subscribe(sid) }
    }

    func disconnect() {
        consumeTask?.cancel()
        consumeTask = nil
        Task { await client.disconnect() }
        phase = .idle
        hasEnteredDashboard = false
    }

    // MARK: Message application

    private func apply(_ message: ServerMessage) {
        reconnectAttempt = 0
        switch message {
        case .sessionsSnapshot(let snap, let ord):
            // REPLACE (not merge) — drops stale ids, faithful to the contract.
            var registry: [String: DashboardSession] = [:]
            for s in snap { registry[s.id] = s }
            sessions = registry
            orders = ord
            phase = .connected
            hasEnteredDashboard = true

        case .sessionAdded(let session, _):
            sessions[session.id] = session

        case .sessionUpdated(let sid, let patch):
            if var existing = sessions[sid] {
                patch.apply(to: &existing)
                sessions[sid] = existing
            }

        case .sessionRemoved(let sid):
            sessions.removeValue(forKey: sid)

        case .sessionsReordered(let cwd, let ids):
            orders[cwd] = ids

        case .pinnedDirsUpdated(let paths):
            pinnedDirectories = paths

        case .eventReplay(let sid, let events, _):
            var state = chatStates[sid] ?? ChatSessionState()
            for seq in events { state = state.reduce(seq.event) }
            chatStates[sid] = state

        case .event(let sid, _, let event):
            var state = chatStates[sid] ?? ChatSessionState()
            state = state.reduce(event)
            chatStates[sid] = state

        case .sendPromptFailed(let sid, let queueNonce, let reason):
            // Bridge-absent / server-side failure: flip the matching queued card (by
            // nonce) OR the optimistic bubble to failed AND raise the banner so the
            // un-delivered message is visible.
            markSendFailed(sid, nonce: queueNonce,
                           reason: reason ?? "Send failed — no bridge connection")

        case .modelsList(let sid, let models):
            // Available models for the picker (replace — authoritative per request).
            availableModels[sid] = models

        case .sessionStateReset(let sid):
            chatStates[sid] = ChatSessionState()

        case .unknown:
            break
        }
    }

    // MARK: Grouped + filtered view

    /// The tier sections the list renders: filter pipeline → tier grouping →
    /// per-tier directory subgroups (pinned-first). All via the core's pure helpers.
    var tierSections: [TierSection] {
        let now = Date().timeIntervalSince1970 * 1000
        var visible = SessionGrouping.filterSessions(Array(sessions.values), activeOnly: false, showHidden: showHidden)
        visible = SessionGrouping.filterStale(visible, staleHoursThreshold: staleHoursThreshold,
                                              hideStale: hideStale, now: now, selectedId: viewedSessionId)
        visible = SessionGrouping.filterByQuery(visible, search)
        return SessionGrouping.groupByTier(visible).map { tier, tierSessions in
            TierSection(
                tier: tier,
                groups: SessionGrouping.groupTierByFolder(
                    tierSessions, folders: folders, orders: orders, pinnedDirectories: pinnedDirectories))
        }
    }

    var totalVisibleCount: Int {
        tierSections.reduce(0) { $0 + $1.groups.reduce(0) { $0 + $1.sessions.count } }
    }

    // MARK: Chat lifecycle (subscribe + view/unview)

    /// On detail appear: subscribe (with lastSeq resume) + mark viewed (session_view).
    func openSession(_ sid: String) async {
        viewedSessionId = sid
        sendFailures.removeValue(forKey: sid)
        await subscribe(sid)
        await safeSend(.sessionView(sessionId: sid))
    }

    func closeSession(_ sid: String) async {
        if viewedSessionId == sid { viewedSessionId = nil }
        await safeSend(.sessionUnview(sessionId: sid))
    }

    private func subscribe(_ sid: String) async {
        await safeSend(.subscribe(sessionId: sid, lastSeq: nil))
    }

    func chatState(_ sid: String) -> ChatSessionState { chatStates[sid] ?? ChatSessionState() }

    // MARK: Compose (guarded)

    /// Send a prompt. SAFETY: refuses in UITest/fixture mode so the smoke suite can
    /// never mutate a live operator session (brief §4). Live send is wired but only
    /// fires against a real connected backend the operator drives.
    ///
    /// Send-while-idle → OPTIMISTIC user bubble (pending), confirmed by the server's
    /// `message_start(role:user)` echo. Send-while-STREAMING → the message is QUEUED
    /// as a follow-up (held for the agent's next turn): a pending queued card is
    /// shown + the bridge confirms via `message_enqueued` and later dispatches it via
    /// `message_start(queueNonce)`. A send failure flips the matching bubble/card to
    /// failed + surfaces a banner so an undelivered message is visible.
    func sendPrompt(_ sid: String, text: String, images: [ImageContent]?) async {
        guard !isUITest else { return }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || (images?.isEmpty == false) else { return }

        let nonce = UUID().uuidString
        var state = chatStates[sid] ?? ChatSessionState()
        let isStreaming = state.isStreaming
        // 1) Optimistic feedback — queued card while streaming, else a user bubble.
        if isStreaming {
            state = state.enqueueingOptimistic(text: trimmed, images: images ?? [], nonce: nonce)
        } else {
            state = state.appendingOptimisticUser(
                text: trimmed, images: images ?? [], timestamp: nowMs(), nonce: nonce)
        }
        chatStates[sid] = state
        sendFailures.removeValue(forKey: sid)

        // 2) Fire the send; surface a throw (not-connected / socket error) as a
        // failed bubble/card + banner so a send that didn't land is VISIBLE.
        do {
            try await client.send(
                .sendPrompt(sessionId: sid, text: trimmed, images: images, queueNonce: nonce))
        } catch {
            markSendFailed(sid, nonce: nonce,
                           reason: isStreaming ? "Couldn't queue — not connected."
                                               : "Couldn't send — not connected.")
        }
    }

    func abort(_ sid: String) async {
        guard !isUITest else { return }
        await safeSend(.abort(sessionId: sid))
    }

    /// Retry a `failed` queued follow-up: drop the failed card, re-send the text as a
    /// fresh queued entry (new nonce). No-op if the nonce isn't a failed queued entry.
    func retryQueued(_ sid: String, nonce: String) async {
        guard !isUITest, var state = chatStates[sid],
              let entry = state.queued.first(where: { $0.queueNonce == nonce && $0.status == .failed })
        else { return }
        state.queued.removeAll { $0.queueNonce == nonce }
        chatStates[sid] = state
        await sendPrompt(sid, text: entry.text, images: entry.images.isEmpty ? nil : entry.images)
    }

    // MARK: Model + thinking-level

    /// Ask the server for the available models (reply arrives as `models_list` →
    /// `availableModels[sid]`). Called when the picker sheet appears.
    func requestModels(_ sid: String) async {
        await safeSend(.requestModels(sessionId: sid))
    }

    /// Switch the session's model. The confirmation arrives via `session_updated`
    /// (the title + checkmark update through the session registry).
    func setModel(_ sid: String, provider: String, modelId: String) async {
        await safeSend(.setModel(sessionId: sid, provider: provider, modelId: modelId))
    }

    /// Set the session's thinking/reasoning level (off/minimal/low/medium/high/xhigh).
    func setThinkingLevel(_ sid: String, level: String) async {
        await safeSend(.setThinkingLevel(sessionId: sid, level: level))
    }

    /// Flip the matching optimistic bubble OR queued card (by nonce) to failed +
    /// raise the banner. `nonce` nil → the latest pending user bubble (failure path
    /// from `send_prompt_failed` which doesn't always carry our nonce back).
    private func markSendFailed(_ sid: String, nonce: String?, reason: String) {
        if var state = chatStates[sid] {
            if let nonce, state.queued.contains(where: { $0.queueNonce == nonce }) {
                state = state.markingQueuedFailed(nonce: nonce)
            } else {
                state = state.markingLatestOptimisticFailed()
            }
            chatStates[sid] = state
        }
        sendFailures[sid] = reason
    }

    /// Epoch-ms timestamp for optimistic rows (matches the server event timebase).
    private func nowMs() -> Double { Date().timeIntervalSince1970 * 1000 }

    private func safeSend(_ message: ClientMessage) async {
        guard !isUITest else { return }
        do { try await client.send(message) } catch { /* surfaced via banner/phase */ }
    }

    // MARK: UITest fixtures

    /// Load a bundled fixture snapshot + a scripted chat so the XCUITest smoke runs
    /// hermetically (no live server, no mutation). Mirrors the real apply() paths.
    private func loadFixtures() {
        let snapshot = FixtureData.sessionsSnapshot()
        var registry: [String: DashboardSession] = [:]
        for s in snapshot.sessions { registry[s.id] = s }
        sessions = registry
        orders = snapshot.orders
        pinnedDirectories = snapshot.pinned
        health = HealthStatus(ok: true, version: "fixture", mode: "production",
                              uptime: 1, starter: "UITest", pid: 0,
                              server: .init(activeSessions: registry.count, totalSessions: registry.count, eventStoreSessions: 0))
        phase = .connected
        hasEnteredDashboard = true
        // Seed a chat for the first session so ChatView + composer render.
        if let first = snapshot.sessions.first {
            chatStates[first.id] = FixtureData.chatState()
            viewedSessionId = nil
        }
    }
}
