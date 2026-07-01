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
    var serverURLString: String
    var token: String
    /// Set once a successful connect has entered the dashboard — keeps MainView
    /// mounted across transient drops (only the banner changes).
    private(set) var hasEnteredDashboard = false
    /// True while a launch auto-connect (to a persisted server) is in flight — the
    /// root shows a splash instead of the connect form during this window.
    private(set) var isAutoConnecting = false

    // Registry
    private(set) var sessions: [String: DashboardSession] = [:]
    private(set) var orders: [String: [String]] = [:]
    private(set) var pinnedDirectories: [String] = []

    // Filters (mirror the PWA toggles)
    var folders = true
    var hideStale = false
    var showHidden = false
    /// Hide ENDED sessions (DF#2 declutter). Default ON — old crew tenures flood the
    /// list. Persisted (unlike the other in-memory toggles) so it survives launches.
    var hideEnded = ListPrefsStore.loadHideEnded() {
        didSet { ListPrefsStore.saveHideEnded(hideEnded) }
    }
    var staleHoursThreshold: Double = 12
    var search = ""

    // Chat
    private(set) var chatStates: [String: ChatSessionState] = [:]
    /// Sessions whose large `event_replay` is being folded OFF the main actor (DF#5).
    /// Live events + further replay chunks for these sessions buffer until the fold
    /// publishes, so nothing clobbers the historical reduce or lands out of order.
    private var replayInFlight: Set<String> = []
    private var bufferedDuringReplay: [String: [DashboardEvent]] = [:]
    /// Replay batches at/under this size fold synchronously (cheap); larger ones go
    /// off-main to keep the UI responsive on open.
    private static let syncReplayThreshold = 150
    /// sessionId → max applied `seq` (Cluster 1). Drives resume-with-lastSeq on
    /// reopen/reconnect + live-event dedup (ignore `seq <= lastSeen`). `nil` = nothing
    /// applied yet → subscribe requests a full replay.
    private var lastSeenSeq: [String: Int] = [:]
    /// Sessions for which the pending replay is an AUTHORITATIVE full replay (we
    /// subscribed with `lastSeq: nil`) → reset state before reducing so history can't
    /// duplicate. A resume replay (subscribed with a real lastSeq) is NOT in this set.
    private var expectingFullReplay: Set<String> = []
    /// sessionId → last send failure reason (bridge absent), surfaced in ChatView.
    private(set) var sendFailures: [String: String] = [:]
    /// Sessions with an in-flight abort (optimistic "stopping…" state). Cleared when
    /// the server confirms the stop via a status→idle/ended `session_updated` delta.
    private(set) var aborting: Set<String> = []
    /// Sessions with an in-flight resume (optimistic "resuming…" state) for instant
    /// feedback before the server's `session_updated{resuming:true}` lands. Cleared
    /// when the server settles it (resuming→false, or the session leaves `ended`).
    private(set) var resumingLocal: Set<String> = []
    /// Directories with an in-flight spawn (optimistic "starting…" state, keyed by
    /// cwd — spawn has no sessionId). Cleared when a `session_added` arrives for that
    /// dir (the new session appearing is the confirm) or a safety timeout fires.
    private(set) var spawning: Set<String> = []
    /// Last control-action failure message (Cluster 2) — resume/spawn `*_result`
    /// `{success:false}` or `spawn_error`. Surfaced to the operator as a dismissable
    /// banner so a failed control is NEVER silent. nil = nothing to show.
    private(set) var actionError: String?
    /// sessionId → available models (populated by `models_list` after requestModels).
    private(set) var availableModels: [String: [ModelInfo]] = [:]
    /// sessionId currently on screen — drives session_view/unview.
    private(set) var viewedSessionId: String?

    private let client = DashboardClient()
    private var consumeTask: Task<Void, Never>?
    private var bootstrapTask: Task<Void, Never>?
    private var didBootstrap = false
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
        if isUITest {
            // Hermetic: the e2e/smoke suites pin the localhost default + empty token.
            serverURLString = "http://localhost:8000"
            token = ""
        } else {
            // Fresh install → baked-in default; otherwise the last persisted server.
            let prefs = ConnectionPreferences.load()
            serverURLString = prefs.serverURL
            token = prefs.token ?? ""
        }
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
        // If a bootstrap auto-connect was cancelled mid-probe (operator tapped
        // "Change server"), don't enter the dashboard behind their back.
        if Task.isCancelled { return }
        // Reached only on a good probe: remember this server so the next launch
        // auto-connects to it (skips the connect form).
        ConnectionPreferences.save(serverURL: serverURLString, token: token.isEmpty ? nil : token)
        startStream(base: url)
    }

    /// Called once from the root on first appear. If a server was persisted from a
    /// prior successful connect, auto-connect to it — the root shows a splash and
    /// skips the connect form. A fresh install (no stored server) is a no-op, so the
    /// editable connect form is shown. Never runs under `-uitest`.
    func bootstrap() {
        guard !isUITest, !didBootstrap else { return }
        didBootstrap = true
        guard ConnectionPreferences.hasStoredServer() else { return }
        isAutoConnecting = true
        bootstrapTask = Task { [weak self] in
            guard let self else { return }
            await self.connect()
            self.isAutoConnecting = false
        }
    }

    /// Escape hatch from the auto-connect splash back to the editable connect form:
    /// cancels an in-flight bootstrap and drops to `.idle` so the operator can edit
    /// the server URL / token.
    func showConnectForm() {
        bootstrapTask?.cancel()
        bootstrapTask = nil
        isAutoConnecting = false
        disconnect()
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
        // Re-subscribe AND re-view the on-screen session so BOTH live events and the
        // viewed-state resume after a reconnect (DF#4: the old path only re-subscribed,
        // so `session_view` was never re-sent and the server thought nobody was
        // watching). `openSession` does subscribe + session_view together.
        if let sid = viewedSessionId { await openSession(sid) }
    }

    /// Foreground revalidation (DF#4): when the app returns to `.active` the socket
    /// may be silently half-open (suspended in the background, peer/NAT dropped it).
    /// Force a fresh reconnect — restart the stream + re-subscribe/re-view — so a
    /// stale view revives immediately instead of waiting for the keepalive deadline.
    /// No-op unless we've entered the dashboard on a real (non-UITest) connection.
    func revalidate() {
        guard !isUITest, hasEnteredDashboard, let base else { return }
        phase = .reconnecting
        startStream(base: base)
        if let sid = viewedSessionId { Task { await openSession(sid) } }
    }

    func disconnect() {
        consumeTask?.cancel()
        consumeTask = nil
        Task { await client.disconnect() }
        phase = .idle
        hasEnteredDashboard = false
        // Cluster 1: drop all per-session chat/seq/replay caches on disconnect so a
        // reconnect rebuilds from authoritative replays (no stale rows, bounded memory).
        chatStates.removeAll()
        lastSeenSeq.removeAll()
        expectingFullReplay.removeAll()
        bufferedDuringReplay.removeAll()
        replayInFlight.removeAll()
    }

    /// Evict all per-session chat/seq/replay caches for one session (Cluster 1). Used
    /// on `session_removed`. Leaves the persisted read-position alone (intentional —
    /// it's a durable user preference, not live state).
    private func evictSession(_ sid: String) {
        chatStates.removeValue(forKey: sid)
        lastSeenSeq.removeValue(forKey: sid)
        expectingFullReplay.remove(sid)
        bufferedDuringReplay.removeValue(forKey: sid)
        replayInFlight.remove(sid)
    }

    // MARK: Message application

    private func apply(_ message: ServerMessage) {
        switch message {
        case .sessionsSnapshot(let snap, let ord):
            // REPLACE (not merge) — drops stale ids, faithful to the contract.
            var registry: [String: DashboardSession] = [:]
            for s in snap { registry[s.id] = s }
            sessions = registry
            orders = ord
            phase = .connected
            hasEnteredDashboard = true
            // Backoff resets ONLY on this real ready condition (DF#4 #5) — a fresh
            // snapshot proves the reconnect fully succeeded. Resetting on any stray
            // frame (the old behavior) let a flapping socket keep short-cycling.
            reconnectAttempt = 0

        case .sessionAdded(let session, _):
            sessions[session.id] = session
            // Spawn confirmed: a new session appeared in a directory we were spawning
            // into → clear the optimistic "starting…" flag for that cwd.
            let addedDir = SessionGrouping.groupPath(session)
            if !addedDir.isEmpty { spawning.remove(addedDir) }

        case .sessionUpdated(let sid, let patch):
            if var existing = sessions[sid] {
                patch.apply(to: &existing)
                sessions[sid] = existing
            }
            // Abort confirmed: the server settled the session out of streaming →
            // clear the optimistic "stopping…" flag.
            if aborting.contains(sid), let st = sessions[sid]?.status, st == "idle" || st == "ended" {
                aborting.remove(sid)
            }
            // Resume settled: the server cleared `resuming` (failure/timeout) OR the
            // session left `ended` (respawn registered → active/streaming/idle) →
            // clear the optimistic "resuming…" flag.
            if resumingLocal.contains(sid), let s = sessions[sid],
               s.resuming != true || (s.status != nil && s.status != "ended") {
                resumingLocal.remove(sid)
            }

        case .sessionRemoved(let sid):
            sessions.removeValue(forKey: sid)
            aborting.remove(sid)
            resumingLocal.remove(sid)
            evictSession(sid) // Cluster 1: drop chat/seq/replay caches for a gone session.

        case .sessionsReordered(let cwd, let ids):
            orders[cwd] = ids

        case .pinnedDirsUpdated(let paths):
            pinnedDirectories = paths

        case .eventReplay(let sid, let events, let isLast):
            let evs = events.map(\.event)
            let batchMax = events.map(\.seq).max()
            // Reset-before-authoritative-replay (Cluster 1): if we subscribed with
            // lastSeq:nil, this replay is the FULL history — clear the session state +
            // seq FIRST so it can't duplicate onto existing rows. Only the first batch
            // resets; a chunked full replay (isLast:false…true) keeps building.
            let resetFirst = expectingFullReplay.contains(sid)
            if resetFirst {
                chatStates[sid] = ChatSessionState()
                lastSeenSeq[sid] = nil
                bufferedDuringReplay[sid] = nil
                expectingFullReplay.remove(sid) // consumed — later chunks append
            }
            // Adopt the batch's max seq (monotonic) so live dedup + the next resume
            // pick up from the right point.
            lastSeenSeq[sid] = SeqLifecycle.advance(lastSeen: lastSeenSeq[sid], batchMaxSeq: batchMax)
            _ = isLast // (chunked-replay boundary; state simply accumulates across chunks)

            if replayInFlight.contains(sid) {
                // A fold is already running for this session — buffer these too so
                // they drain (in order) after it publishes; never clobber the fold.
                bufferedDuringReplay[sid, default: []].append(contentsOf: evs)
            } else if evs.count <= Self.syncReplayThreshold {
                // Small batch — fold synchronously (no async overhead / flicker).
                chatStates[sid] = (chatStates[sid] ?? ChatSessionState()).reduce(events: evs)
            } else {
                // Large batch (the "won't load" hang): fold OFF the main actor so
                // opening a big session doesn't freeze the UI, then publish on main.
                // `ChatSessionState` is Sendable + `reduce(events:)` is a pure value
                // method, so the fold is safe off-isolation. Live events arriving
                // during the fold are buffered (see `.event`) and drained on publish.
                // (The reset above already ran on the base state, so the fold folds
                // onto the freshly-reset state — no duplication.)
                replayInFlight.insert(sid)
                let base = chatStates[sid] ?? ChatSessionState()
                Task.detached(priority: .userInitiated) { [weak self] in
                    let reduced = base.reduce(events: evs)
                    await self?.publishReplay(sid: sid, reduced: reduced)
                }
            }

        case .event(let sid, let seq, let event):
            // Seq-dedup (Cluster 1): drop a duplicate or out-of-order live event so it
            // can't corrupt state. A newer seq is applied + advances lastSeen.
            guard SeqLifecycle.shouldApply(seq: seq, lastSeen: lastSeenSeq[sid]) else { break }
            lastSeenSeq[sid] = SeqLifecycle.advance(lastSeen: lastSeenSeq[sid], appliedSeq: seq)
            if replayInFlight.contains(sid) {
                // A large replay fold is in flight — buffer so this live event drains
                // AFTER the historical fold (correct order), never onto stale state.
                bufferedDuringReplay[sid, default: []].append(event)
            } else {
                chatStates[sid] = (chatStates[sid] ?? ChatSessionState()).reduce(event)
            }

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

        case .resumeResult(let sid, let success, let message, _):
            // Authoritative resume outcome (Cluster 2): clear the pending spinner on
            // EITHER path (success OR failure) — the result, not the 8s timeout, is the
            // truth. Correlated by sessionId (the resumingLocal key). On failure the
            // server sends this WITHOUT a `session_updated{resuming:true}`, so without
            // this the spinner hung until timeout, silently. Surface the error.
            resumingLocal.remove(sid)
            if !success {
                actionError = message.isEmpty ? "Resume failed." : message
            }

        case .spawnResult(let cwd, let success, let message, _):
            // Authoritative spawn outcome (Cluster 2): clear the "starting…" flag for
            // this cwd on either path. A failure sends no `session_added`, so this is
            // the only non-timeout clear. Surface the error.
            spawning.remove(cwd)
            if !success {
                actionError = message.isEmpty ? "Couldn't start a session in \(cwd)." : message
            }

        case .spawnError(let cwd, let message, let code):
            // Hard spawn failure (Cluster 2) — companion to spawn_result{success:false}.
            // Clear the pending + surface the classifier-tagged message.
            spawning.remove(cwd)
            let detail = message.isEmpty ? "Spawn failed." : message
            actionError = code.map { "\(detail) (\($0))" } ?? detail

        case .unknown:
            break
        }
    }

    /// Dismiss the current action-error banner (Cluster 2).
    func clearActionError() { actionError = nil }

    /// Publish an off-main replay fold back onto the main actor (DF#5). Drains any
    /// live events / further replay chunks that arrived DURING the fold (in arrival
    /// order) onto the reduced state, so the final transcript = history + everything
    /// that landed meanwhile, correctly ordered. Clears the in-flight guard.
    private func publishReplay(sid: String, reduced: ChatSessionState) {
        var state = reduced
        if let buffered = bufferedDuringReplay[sid], !buffered.isEmpty {
            state = state.reduce(events: buffered)
        }
        bufferedDuringReplay.removeValue(forKey: sid)
        replayInFlight.remove(sid)
        chatStates[sid] = state
    }

    // MARK: Grouped + filtered view

    /// The tier sections the list renders: filter pipeline → tier grouping →
    /// per-tier directory subgroups (pinned-first). All via the core's pure helpers.
    var tierSections: [TierSection] {
        let now = Date().timeIntervalSince1970 * 1000
        var visible = SessionGrouping.filterSessions(Array(sessions.values), activeOnly: false, showHidden: showHidden)
        visible = SessionGrouping.filterStale(visible, staleHoursThreshold: staleHoursThreshold,
                                              hideStale: hideStale, now: now, selectedId: viewedSessionId)
        visible = SessionGrouping.filterEnded(visible, hideEnded: hideEnded, selectedId: viewedSessionId)
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

    /// On detail appear: subscribe (resuming from the last applied seq when we've seen
    /// this session before, else a full replay) + mark viewed (session_view).
    func openSession(_ sid: String) async {
        viewedSessionId = sid
        sendFailures.removeValue(forKey: sid)
        await subscribe(sid)
        await safeSend(.sessionView(sessionId: sid))
    }

    func closeSession(_ sid: String) async {
        if viewedSessionId == sid { viewedSessionId = nil }
        // Cluster 1: unsubscribe so an off-screen session STOPS receiving live events
        // (unbounded memory + wasted work otherwise); session_unview is UI-only.
        await safeSend(.unsubscribe(sessionId: sid))
        await safeSend(.sessionUnview(sessionId: sid))
    }

    /// Subscribe with resume semantics (Cluster 1): `lastSeq = lastSeenSeq[sid]` — nil
    /// on first open (→ full replay, reset-before-reduce), the last applied seq on
    /// reopen/reconnect (→ the server sends only NEW events, no reset). Records whether
    /// a full replay is expected so `.eventReplay` knows to reset.
    private func subscribe(_ sid: String) async {
        let last = SeqLifecycle.subscribeLastSeq(lastSeen: lastSeenSeq[sid])
        if SeqLifecycle.expectsFullReplay(lastSeq: last) {
            expectingFullReplay.insert(sid)
        } else {
            expectingFullReplay.remove(sid)
        }
        await safeSend(.subscribe(sessionId: sid, lastSeq: last))
    }

    func chatState(_ sid: String) -> ChatSessionState { chatStates[sid] ?? ChatSessionState() }

    // MARK: Read-position + engagement-weighted unread (DF#3)

    /// Persist the operator's last-read message for a session (LOCAL-first, via the
    /// core `ReadPositionStore`). Called as they scroll near a row and on close, so
    /// re-opening restores that position instead of jumping to the end.
    func markRead(_ sid: String, messageId: String) {
        ReadPositionStore.save(sid, messageId: messageId)
    }

    /// The persisted last-read message id for a session (nil = never read).
    func lastReadId(_ sid: String) -> String? { ReadPositionStore.load(sid) }

    /// Engagement-weighted unread for a session: count of Tier-A asks (ask_user /
    /// confirm / select) that arrived AFTER the last-read position — NOT the raw
    /// message count (agents spam hundreds of tool-calls). Drives the card badge.
    func unreadTierACount(_ sid: String) -> Int {
        UnreadCounter.tierAUnreadCount(chatState(sid).messages, lastReadId: ReadPositionStore.load(sid))
    }

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
            return
        }

        // 3) ACK SAFETY-NET (DF#1): the send left the socket with no error, but the
        // server's user `message_start` echo may never nonce/text-match this bubble
        // (bridge committed straight to work, whitespace/skill drift) — leaving it
        // stuck "Sending…". After a grace window, if the `optim-<nonce>` bubble is
        // STILL pending, reconcile it to CONFIRMED (the message WAS sent — never
        // false-mark failed here; only a throw / `send_prompt_failed` fails it). The
        // streaming/queued path has its own `message_enqueued`/`queue_state`
        // reconciliation, so this net targets the non-streaming bubble.
        if !isStreaming {
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(10))
                guard let self else { return }
                guard var st = self.chatStates[sid],
                      st.messages.contains(where: { $0.id == "optim-\(nonce)" && $0.delivery == .pending })
                else { return }
                st = st.reconcilePendingToConfirmed(nonce: nonce)
                self.chatStates[sid] = st
            }
        }
    }

    /// Stop a running session — the app's first control action. Optimistically flips
    /// to a "stopping…" state, then sends the browser-protocol abort via the client's
    /// `abort` convenience. The server confirms by flipping the session
    /// streaming→idle/ended (a `session_updated` delta), which clears the flag in
    /// `apply`. On a send throw the optimistic flag is rolled back so the button
    /// re-arms. UITest is a no-op (never touches a live session).
    func abort(_ sid: String) async {
        guard !isUITest else { return }
        aborting.insert(sid)
        do {
            try await client.abort(sessionId: sid)
        } catch {
            aborting.remove(sid) // send failed — re-arm the Stop button
        }
    }

    /// Whether an abort is in flight for `sid` (drives the "Stopping…" UI).
    func isAborting(_ sid: String) -> Bool { aborting.contains(sid) }

    /// Resume (continue) an ended session — the app's second control action.
    /// Optimistically flips to a "resuming…" state, then sends the browser-protocol
    /// `resume_session` (mode "continue") via the client's `resume` convenience. The
    /// server sets `resuming: true` and later settles it (resuming→false, or the
    /// session leaves `ended`), which clears the local flag in `apply`. On a send
    /// throw the optimistic flag is rolled back so the button re-arms. UITest is a
    /// no-op. RESUME only — fork/spawn are separate controls.
    func resume(_ sid: String) async {
        guard !isUITest else { return }
        resumingLocal.insert(sid)
        do {
            try await client.resume(sessionId: sid)
        } catch {
            resumingLocal.remove(sid) // send failed — re-arm the Resume button
            return
        }
        // Safety-net timeout (Cluster 2 made the result authoritative): the resume
        // outcome now arrives as `resume_result` and clears `resumingLocal` in apply()
        // — success OR failure. This timeout is only a fallback for a dropped result
        // frame; it clears the flag UNLESS the server took ownership (resuming == true).
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(8))
            guard let self else { return }
            if self.sessions[sid]?.resuming != true { self.resumingLocal.remove(sid) }
        }
    }

    /// Whether a resume is in flight for `sid` — the optimistic local flag OR the
    /// server-truth `resuming` field (drives the "Resuming…" UI).
    func isResuming(_ sid: String) -> Bool {
        resumingLocal.contains(sid) || sessions[sid]?.resuming == true
    }

    /// Distinct directories the app already knows (every session's group path ∪
    /// pinned dirs), deduped + sorted — the "+ New session" picker's options. Spawn
    /// in a KNOWN dir only; the server-filesystem browser is deferred.
    var knownDirectories: [String] {
        SessionGrouping.knownDirectories(sessions: Array(sessions.values), pinned: pinnedDirectories)
    }

    /// Start a new session in an existing directory — the app's third + final B3
    /// control action. Optimistically flips that cwd to a "starting…" state, then
    /// sends the browser-protocol `spawn_session` via the client's `spawn` convenience
    /// (server defaults for strategy/model — no advanced options this increment). On
    /// success a `session_added` for that cwd clears the flag; on FAILURE (Cluster 2)
    /// a `spawn_result{success:false}` / `spawn_error` clears it + surfaces the error.
    /// On a send throw the flag is rolled back. UITest is a no-op.
    func spawn(cwd: String) async {
        guard !isUITest else { return }
        let dir = cwd.trimmingCharacters(in: .whitespaces)
        guard !dir.isEmpty else { return }
        spawning.insert(dir)
        do {
            try await client.spawn(cwd: dir)
        } catch {
            spawning.remove(dir) // send failed — re-arm the picker
            return
        }
        // Safety-net timeout only (Cluster 2 made the result authoritative): the
        // spawn outcome now clears `spawning` via spawn_result/spawn_error/session_added
        // in apply(). This fallback covers a dropped result frame so the row can't hang.
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(12))
            self?.spawning.remove(dir)
        }
    }

    /// Whether a spawn is in flight for `cwd` (drives the "Starting…" row).
    func isSpawning(_ cwd: String) -> Bool { spawning.contains(cwd) }

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
