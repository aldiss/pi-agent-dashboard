import Foundation

/// The role a rendered chat row plays. Faithful subset of the `ChatMessage.role`
/// union in `packages/client/src/lib/event-reducer.ts` (the MVP renders text /
/// thinking / tool call+result / turn separators / bash output / raw events).
/// PromptBus interactive controls are store-owned `DashboardPromptRequest` values,
/// not transcript roles; flow/architect panels remain outside this reducer.
public enum ChatRole: String, Sendable, Equatable {
    case user, assistant, toolResult, thinking, bashOutput, commandFeedback, turnSeparator, rawEvent
}

public enum ToolStatus: String, Sendable, Equatable {
    case running, complete, error
}

/// Delivery state of an OPTIMISTICALLY-rendered user message — one the app appended
/// the instant Send was tapped, before the server echoed it back. `nil` means a
/// normal server-originated row (no badge). `pending` = sent, awaiting the echo;
/// `confirmed` = the server's `message_start(role:user)` echo matched + replaced it;
/// `failed` = the send threw or `send_prompt_failed` arrived (offer a retry).
public enum DeliveryStatus: String, Sendable, Equatable {
    case pending, confirmed, failed
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
    /// Delivery state for an optimistic user bubble (nil for server-originated rows).
    public var delivery: DeliveryStatus?
    /// Free-form per-row metadata (e.g. bash `command`/`exitCode`, command-feedback `status`).
    public var args: [String: JSONValue]

    public init(id: String, role: ChatRole, content: String, images: [ImageContent] = [],
                toolName: String? = nil, toolCallId: String? = nil, toolStatus: ToolStatus? = nil,
                result: String? = nil, timestamp: Double, startedAt: Double? = nil,
                duration: Double? = nil, delivery: DeliveryStatus? = nil,
                args: [String: JSONValue] = [:]) {
        self.id = id; self.role = role; self.content = content; self.images = images
        self.toolName = toolName; self.toolCallId = toolCallId; self.toolStatus = toolStatus
        self.result = result; self.timestamp = timestamp; self.startedAt = startedAt
        self.duration = duration; self.delivery = delivery; self.args = args
    }
}

/// In-flight tool call bookkeeping (mirrors `ToolCallState`).
public struct ToolCallState: Sendable, Equatable {
    public var toolCallId: String
    public var toolName: String
    public var args: [String: JSONValue]
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

/// Origin of a queued follow-up: `dashboard` (this app) vs `tui` (pi's terminal).
public enum QueueSource: String, Sendable, Equatable {
    case dashboard, tui
}

/// A follow-up message held for the agent's next turn (sent while it was streaming).
/// Mirrors the PWA `QueuedMessage`. `status`: `pending` = optimistic, not yet acked
/// by the bridge; `confirmed` = in the bridge's authoritative queue; `failed` = the
/// send/enqueue failed. `queueNonce` correlates the optimistic card with the
/// bridge's `message_enqueued` / `message_start(queueNonce)` dispatch.
public struct QueuedMessage: Sendable, Equatable, Identifiable {
    public enum Status: String, Sendable, Equatable { case pending, confirmed, failed }
    public var queueNonce: String
    public var text: String
    public var images: [ImageContent]
    public var source: QueueSource
    public var status: Status
    public var id: String { queueNonce }

    public init(queueNonce: String, text: String, images: [ImageContent] = [],
                source: QueueSource = .dashboard, status: Status = .pending) {
        self.queueNonce = queueNonce; self.text = text; self.images = images
        self.source = source; self.status = status
    }
}

/// What the live streaming indicator should render for a working session. Resolved
/// purely from `ChatSessionState` (see `streamingIndicator`) so the view is a thin
/// switch and the decision is `swift test`-pinned. Priority: committed streaming text
/// wins (it's the answer arriving); else a running tool; else live reasoning; else a
/// bare "working" pulse. `hidden` when the session isn't streaming.
public enum StreamingIndicatorKind: Sendable, Equatable {
    case hidden
    case text                 // streamingText is non-empty → the answer is arriving
    case tool(String)         // a tool is running → "running <tool>… M:SS"
    case thinking(String)     // live reasoning flowing (no tool, no text) → show it moving
    case waiting              // streaming but nothing surfaced yet → "thinking… M:SS"
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
    /// Epoch-ms the current agent run began (set on `agent_start`, cleared on
    /// `agent_end`). Drives the working-state elapsed timer ("thinking… 0:45") so a
    /// long turn reads as ALIVE, not hung. Turn-level, NOT per-thinking-block (that's
    /// `thinkingStartedAt`). nil ⇒ not streaming ⇒ no timer.
    public var streamingStartedAt: Double?
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
    /// Follow-up messages held for the agent's next turn (send-while-streaming).
    /// Head = next to dispatch. Mirrors the PWA per-session `queue[]`.
    public var queued: [QueuedMessage] = []
    /// Old nonces replaced by Retry. Late confirmations/snapshots for them are inert
    /// so a slow first attempt cannot resurrect beside its fresh retry.
    public var supersededQueueNonces: Set<String> = []
    /// True once the current assistant message's streaming text has been flushed
    /// into a permanent row (mirrors `streamingTextFlushed`). Reset at each
    /// assistant message_start and message_end.
    public var streamingTextFlushed: Bool = false

    public init() {}

    private static let maxTurnStats = 50

    // MARK: Optimistic user echo (dashboard-sent prompts)

    /// Append the operator's prompt as a `pending` user bubble the INSTANT Send is
    /// tapped — so the message shows immediately (like the PWA), before the server
    /// round-trip. The later `message_start(role:user)` echo confirms it in place
    /// (see the reducer's user arm), avoiding a double bubble. `id` is unique per
    /// optimistic send so multiple pending rows don't collide.
    public func appendingOptimisticUser(text: String, images: [ImageContent] = [],
                                        timestamp: Double, nonce: String) -> ChatSessionState {
        var next = self
        next.messages.append(ChatMessage(
            id: "optim-\(nonce)", role: .user, content: text, images: images,
            timestamp: timestamp, delivery: .pending))
        return next
    }

    /// Flip the most-recent still-`pending` user bubble to `failed` (the send threw,
    /// or `send_prompt_failed` arrived) so the operator sees it didn't land + can
    /// retry. No-op when there's no pending row. Pure.
    public func markingLatestOptimisticFailed() -> ChatSessionState {
        guard let idx = messages.lastIndex(where: { $0.role == .user && $0.delivery == .pending })
        else { return self }
        var next = self
        next.messages[idx].delivery = .failed
        return next
    }

    /// Confirm the optimistic bubble that carries `nonce` — matched by its stable
    /// `optim-<nonce>` id, NOT by fragile text. The primary reconcile path: the
    /// server's `message_start`/`message_enqueued` echo carries the client-minted
    /// `queueNonce`, so we clear "Sending…" on the RIGHT bubble even when two sends
    /// share identical text. A late genuine echo may recover a row already marked
    /// failed by the no-ack deadline. Adopts the server timestamp + images.
    /// Returns `(state, matched)` — `matched == false` means no such optimistic
    /// bubble (caller falls back to text-match / appends). Pure.
    public func confirmingOptimisticUser(nonce: String, timestamp: Double,
                                         images: [ImageContent] = []) -> (state: ChatSessionState, matched: Bool) {
        guard let idx = messages.firstIndex(where: {
            $0.id == "optim-\(nonce)" && $0.role == .user && $0.delivery != .confirmed
        }) else { return (self, false) }
        var next = self
        next.messages[idx].delivery = .confirmed
        next.messages[idx].timestamp = timestamp
        if !images.isEmpty { next.messages[idx].images = images }
        return (next, true)
    }

    /// Mark the exact optimistic bubble failed when no application-level echo
    /// arrives before the delivery deadline. A WebSocket write completing only means
    /// bytes entered the local socket buffer; it is not server/bridge acceptance.
    /// Confirmed/absent rows remain unchanged. A later genuine echo can recover the
    /// failed row via `confirmingOptimisticUser` or the semantic fallback.
    public func markingOptimisticFailed(nonce: String) -> ChatSessionState {
        guard let idx = messages.firstIndex(where: {
            $0.id == "optim-\(nonce)" && $0.role == .user && $0.delivery == .pending
        }) else { return self }
        var next = self
        next.messages[idx].delivery = .failed
        return next
    }

    /// Whether any optimistic user bubble is still awaiting confirmation.
    public var hasPendingOptimisticUser: Bool {
        messages.contains { $0.role == .user && $0.delivery == .pending }
    }

    /// Mark every locally pending send uncertain when the transport drops. Late
    /// application-level acknowledgements may still recover each row/card in place.
    public func failingPendingLocalSends() -> ChatSessionState {
        var next = self
        for index in next.messages.indices
            where next.messages[index].id.hasPrefix("optim-")
                && next.messages[index].delivery == .pending {
            next.messages[index].delivery = .failed
        }
        for index in next.queued.indices where next.queued[index].status == .pending {
            next.queued[index].status = .failed
        }
        return next
    }

    /// Start an authoritative replay without deleting local intent that the server
    /// may not know about yet. Confirmed history is rebuilt from replay; only
    /// pending/failed optimistic rows and the follow-up queue survive so later
    /// acknowledgements can reconcile them instead of making them disappear.
    public func resetPreservingLocalIntent() -> ChatSessionState {
        var reset = ChatSessionState()
        reset.messages = messages.filter {
            $0.role == .user && $0.id.hasPrefix("optim-")
                && ($0.delivery == .pending || $0.delivery == .failed)
        }
        reset.queued = queued
        reset.supersededQueueNonces = supersededQueueNonces
        return reset
    }

    // MARK: Follow-up queue (send-while-streaming)

    /// Remove a failed queued attempt and remember its nonce so late evidence for
    /// that old attempt cannot resurrect it after Retry creates a fresh nonce.
    public func supersedingQueued(nonce: String) -> ChatSessionState {
        var next = self
        next.queued.removeAll { $0.queueNonce == nonce }
        next.supersededQueueNonces.insert(nonce)
        return next
    }

    /// Append a `pending` queued follow-up — called the instant Send is tapped while
    /// the agent is streaming. The bridge's `message_enqueued(queueNonce)` confirms
    /// it; `message_start(role:user, queueNonce)` later dequeues it into a bubble.
    public func enqueueingOptimistic(text: String, images: [ImageContent] = [],
                                     nonce: String) -> ChatSessionState {
        var next = self
        next.queued.append(QueuedMessage(
            queueNonce: nonce, text: text, images: images, source: .dashboard, status: .pending))
        return next
    }

    /// Flip the matching queued entry to `failed` (send threw / `send_prompt_failed`).
    /// No-op when the nonce isn't queued. Pure.
    public func markingQueuedFailed(nonce: String) -> ChatSessionState {
        guard let idx = queued.firstIndex(where: { $0.queueNonce == nonce }) else { return self }
        var next = self
        next.queued[idx].status = .failed
        return next
    }

    /// Live queue size for the composer "N queued" badge (excludes failed entries —
    /// those are surfaced separately for retry, not counted as still-waiting).
    public var activeQueuedCount: Int {
        queued.filter { $0.status != .failed }.count
    }

    /// What the working-state indicator should show (pure resolver — the view switches
    /// on it). Committed text wins (the answer is arriving), then a running tool, then
    /// live reasoning, then a bare pulse; `hidden` when not streaming. The trimmed
    /// thinking is carried so the view can render the reasoning as it flows.
    public var streamingIndicator: StreamingIndicatorKind {
        guard isStreaming else { return .hidden }
        if !streamingText.isEmpty { return .text }
        if let tool = currentTool, !tool.isEmpty { return .tool(tool) }
        let thinking = streamingThinking.trimmingCharacters(in: .whitespacesAndNewlines)
        if !thinking.isEmpty { return .thinking(streamingThinking) }
        return .waiting
    }

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
            next.streamingStartedAt = ts   // start the working-state elapsed timer

        case "agent_end":
            next.isStreaming = false
            next.status = "idle"
            next.streamingText = ""
            next.currentTool = nil
            next.streamingStartedAt = nil   // stop the timer — the indicator clears

        case "message_start":
            let role = next.messageRole(data)
            if role == "assistant" {
                next.streamingTextFlushed = false
            }
            if role == "user" {
                let (text, images) = ChatSessionState.extractMessageTextAndImages(data["message"])
                // DEQUEUE: a user message_start carrying a queueNonce means that
                // queued follow-up was just pulled into work — remove it from
                // queued[] (it becomes the committed user bubble below). Absent
                // queueNonce = a turn-initiating message (no dequeue).
                let dispatchedNonce = data["queueNonce"]?.stringValue
                // Old attempts can genuinely dispatch after Retry. Render that history,
                // but treat its superseded nonce as already handled so the same-text
                // fallback cannot remove the fresh retry card.
                var dequeued = dispatchedNonce.map(next.supersededQueueNonces.contains) ?? false
                if let dispatched = dispatchedNonce, !dequeued {
                    let before = next.queued.count
                    next.queued.removeAll { $0.queueNonce == dispatched }
                    dequeued = next.queued.count < before
                }
                // SAFETY-NET (nonce drift/absent): the bridge dispatched a confirmed
                // OR timeout-failed queued follow-up but its message_start echo carried
                // no matching nonce. Without this the card lingers after real delivery.
                // Drop the first confirmed/failed same-text entry; a still-pending
                // optimistic row remains protected because it may be a later send.
                if !dequeued {
                    // Compared through `reconcileKey`: the queued card holds the text the
                    // operator typed while the dispatch echo arrives wrapped in the
                    // `<speaker …>` envelope, so a raw comparison never matches and the
                    // card lingers as the phantom "1 queued" this guards.
                    let dispatchedText = SpeakerEnvelope.reconcileKey(text)
                    if !dispatchedText.isEmpty,
                       let qi = next.queued.firstIndex(where: {
                           ($0.status == .confirmed || $0.status == .failed)
                               && SpeakerEnvelope.reconcileKey($0.text) == dispatchedText
                       }) {
                        next.queued.remove(at: qi)
                    }
                }
                // CONFIRM BY NONCE (primary): the server echo carries the client-
                // minted queueNonce, so confirm the exact `optim-<nonce>` bubble by
                // id — robust to identical-text sends and whitespace/skill drift that
                // the text-match below can't handle (the "stuck Sending…" root cause).
                if let dispatched = dispatchedNonce {
                    let (confirmed, matched) = next.confirmingOptimisticUser(
                        nonce: dispatched, timestamp: ts, images: images)
                    if matched { next = confirmed; break }
                }
                // DEDUP (fallback): no nonce match — the server echoes a dashboard-
                // sent prompt back as message_start(role:user). If we already rendered
                // it optimistically (pending, identical content), CONFIRM that row in
                // place instead of appending a second identical bubble. Match the most
                // recent pending user row so repeated identical sends pair 1:1.
                //
                // Compared through `SpeakerEnvelope.reconcileKey`, NOT raw text: the
                // optimistic row holds what the operator typed, while the server echoes
                // it back wrapped in the `<speaker …>` envelope. Raw-text comparison
                // could never match those, so the echo was appended as a second bubble
                // that rendered the envelope and its auth nonce verbatim.
                let trimmed = SpeakerEnvelope.reconcileKey(text)
                if let idx = next.messages.lastIndex(where: {
                    $0.role == .user && $0.id.hasPrefix("optim-")
                        && ($0.delivery == .pending || $0.delivery == .failed)
                        && SpeakerEnvelope.reconcileKey($0.content) == trimmed
                }) {
                    next.messages[idx].delivery = .confirmed
                    // Adopt the server timestamp + any images it carried (authoritative).
                    next.messages[idx].timestamp = ts
                    if !images.isEmpty { next.messages[idx].images = images }
                } else {
                    next.messages.append(ChatMessage(
                        id: "msg-\(next.messages.count)", role: .user, content: text,
                        images: images, timestamp: ts))
                }
            }

        case "message_update":
            var handledThinking = false
            if let ev = data["assistantMessageEvent"]?.objectValue,
               let type = ev["type"]?.stringValue {
                switch type {
                case "thinking_start":
                    handledThinking = true
                    next.streamingThinking = ""
                    next.thinkingStartedAt = ts
                case "thinking_delta":
                    handledThinking = true
                    next.streamingThinking += ev["delta"]?.stringValue ?? ""
                case "thinking_end":
                    handledThinking = true
                    if !next.streamingThinking.isEmpty {
                        let started = next.thinkingStartedAt
                        next.messages.append(ChatMessage(
                            id: "thinking-\(next.messages.count)", role: .thinking,
                            content: next.streamingThinking, timestamp: ts,
                            startedAt: started, duration: started.map { max(0, ts - $0) }))
                    }
                    next.streamingThinking = ""
                    next.thinkingStartedAt = nil
                default:
                    // Real text-delta frames can carry assistantMessageEvent too.
                    // Only thinking events are terminal here; other types must fall
                    // through to the message snapshot below so text streams live.
                    break
                }
            }
            if handledThinking { break }
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
            let args = data["args"]?.objectValue ?? [:]
            next.toolCalls[toolCallId] = ToolCallState(
                toolCallId: toolCallId, toolName: toolName, args: args, status: .running)
            next.currentTool = toolName
            // Idempotent on toolCallId: refresh in place if a row already exists.
            if let idx = next.messages.lastIndex(where: { $0.role == .toolResult && $0.toolCallId == toolCallId }) {
                next.messages[idx].toolName = toolName
                next.messages[idx].args = args
            } else {
                next.messages.append(ChatMessage(
                    id: "tool-\(toolCallId)", role: .toolResult, content: toolName,
                    toolName: toolName, toolCallId: toolCallId, toolStatus: .running,
                    timestamp: ts, startedAt: ts, args: args))
            }

        case "tool_execution_update":
            guard let toolCallId = data["toolCallId"]?.stringValue else { break }
            if let partial = ChatSessionState.displayString(data["partialResult"]),
               let idx = next.messages.lastIndex(where: { $0.toolCallId == toolCallId }) {
                next.messages[idx].result = ChatSessionState.truncateForDisplay(partial, maxLines: 30, maxChars: 20_000)
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
                    next.messages[idx].result = ChatSessionState.truncateForDisplay(result, maxLines: 30, maxChars: 20_000)
                }
                if let started = next.messages[idx].startedAt {
                    next.messages[idx].duration = max(0, ts - started) // clamp clock-skew negatives
                }
                if let images = ChatSessionState.extractToolResultImages(data) {
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
                content: ChatSessionState.truncateForDisplay(data["output"]?.stringValue ?? ""), timestamp: ts,
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

        case "message_enqueued":
            // One follow-up entered the bridge queue (data: {queueNonce,text,images?,source}).
            // dashboard + matching pending nonce → confirm it; tui or unknown nonce
            // → append a fresh confirmed card. Idempotent: an already-confirmed nonce
            // is left as-is. Mirrors the PWA message_enqueued arm (MVP subset).
            if let nonce = data["queueNonce"]?.stringValue {
                guard !next.supersededQueueNonces.contains(nonce) else { break }
                let source: QueueSource = data["source"]?.stringValue == "tui" ? .tui : .dashboard
                let text = data["text"]?.stringValue ?? ""
                let images = ChatSessionState.extractImages(data["images"]) ?? []
                if let idx = next.queued.firstIndex(where: { $0.queueNonce == nonce }) {
                    if next.queued[idx].status != .confirmed {
                        next.queued[idx].status = .confirmed
                        next.queued[idx].source = source
                        if !text.isEmpty { next.queued[idx].text = text }
                        if !images.isEmpty { next.queued[idx].images = images }
                    }
                } else {
                    // Bridge/proxy nonce drift: re-key only a SOLE same-text/source
                    // local candidate. Multiple identical sends stay distinct rather
                    // than guessing which one this acknowledgement belongs to.
                    let key = SpeakerEnvelope.reconcileKey(text)
                    let candidates = next.queued.indices.filter { index in
                        let item = next.queued[index]
                        return source == .dashboard && item.source == .dashboard
                            && item.status != .confirmed && !key.isEmpty
                            && SpeakerEnvelope.reconcileKey(item.text) == key
                    }
                    if candidates.count == 1, let idx = candidates.first {
                        next.queued[idx].queueNonce = nonce
                        next.queued[idx].status = .confirmed
                        if !text.isEmpty { next.queued[idx].text = text }
                        if !images.isEmpty { next.queued[idx].images = images }
                    } else {
                        next.queued.append(QueuedMessage(
                            queueNonce: nonce, text: text, images: images,
                            source: source, status: .confirmed))
                    }
                }
            }

        case "queue_state":
            // The bridge's authoritative snapshot. ATOMIC-REPLACE the confirmed
            // portion with `followUp` (head = next to dispatch), inheriting prior
            // images/text for nonce-matched entries; keep this client's still-pending
            // optimistic entries at the tail (not yet acked). Sister to
            // sessions_snapshot's replace-not-merge. Mirrors the PWA queue_state arm.
            let followUp = data["followUp"]?.arrayValue ?? []
            let priorByNonce: [String: QueuedMessage] = Dictionary(
                next.queued.map { ($0.queueNonce, $0) }, uniquingKeysWith: { a, _ in a })
            var confirmed: [QueuedMessage] = []
            var coveredNonces = Set<String>()
            for (i, entry) in followUp.enumerated() {
                guard let obj = entry.objectValue else { continue }
                let nonce = obj["queueNonce"]?.stringValue ?? "snap-\(Int(ts))-\(i)"
                guard !next.supersededQueueNonces.contains(nonce) else { continue }
                let source: QueueSource = obj["source"]?.stringValue == "tui" ? .tui : .dashboard
                let incomingText = obj["text"]?.stringValue ?? ""
                var prior = priorByNonce[nonce]
                if prior == nil, source == .dashboard, !incomingText.isEmpty {
                    let key = SpeakerEnvelope.reconcileKey(incomingText)
                    let candidates = next.queued.filter {
                        $0.source == .dashboard && $0.status != .confirmed
                            && !coveredNonces.contains($0.queueNonce)
                            && !next.supersededQueueNonces.contains($0.queueNonce)
                            && SpeakerEnvelope.reconcileKey($0.text) == key
                    }
                    if candidates.count == 1 {
                        prior = candidates[0]
                        coveredNonces.insert(candidates[0].queueNonce)
                    }
                }
                let text = incomingText.isEmpty ? (prior?.text ?? "") : incomingText
                confirmed.append(QueuedMessage(
                    queueNonce: nonce, text: text, images: prior?.images ?? [],
                    source: source, status: .confirmed))
                if obj["queueNonce"]?.stringValue != nil { coveredNonces.insert(nonce) }
            }
            // Preserve genuinely-newer not-yet-acked entries (pending/failed) that the
            // snapshot doesn't cover, in their existing order, at the tail.
            let preserved = next.queued.filter {
                $0.status != .confirmed
                    && !coveredNonces.contains($0.queueNonce)
                    && !next.supersededQueueNonces.contains($0.queueNonce)
            }
            next.queued = confirmed + preserved

        case "turn_end":
            break

        case "turn_start", "turn_created":
            // Pure-noise turn-lifecycle markers carrying no renderable content. The
            // default arm below would otherwise emit a `.rawEvent` row per event —
            // the operator's "empty tool_call / turn_start rows". Suppress entirely
            // (emit NO row); `turn_end` already breaks. Genuinely-unknown events
            // still fall through to the `.rawEvent` default (hidden by the
            // systemNotifications filter, available when toggled on for debug).
            // Defensive: if a replay begins mid-run (agent_start already folded, or
            // absent) and the timer is unset while streaming, anchor it here so the
            // elapsed indicator still ticks.
            if next.isStreaming, next.streamingStartedAt == nil {
                next.streamingStartedAt = ts
            }
            break

        default:
            // Unknown event → expandable raw JSON row (mirrors the reducer default).
            next.messages.append(ChatMessage(
                id: "raw-\(event.eventType)-\(Int(ts))-\(next.messages.count)", role: .rawEvent,
                content: ChatSessionState.truncateForDisplay(ChatSessionState.prettyJSON(data)),
                toolName: event.eventType, timestamp: ts))
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

    /// Tool result images arrive in two shapes: state replay pre-extracts `images`,
    /// while live events carry them inside `result.content` blocks.
    static func extractToolResultImages(_ data: [String: JSONValue]) -> [ImageContent]? {
        if let replay = extractImages(data["images"]) { return replay }
        guard let blocks = data["result"]?.objectValue?["content"] else { return nil }
        return extractImages(blocks)
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

    /// Cap a stored payload for display safety (DF#5 perf): clip by BOTH line count
    /// AND character count so a giant tool/bash/raw output can't bloat memory or block
    /// the renderer. Line cap catches long multi-line logs; char cap catches a single
    /// pathological megabyte-long line the line cap would miss. Appends a marker when
    /// clipped. Generous caps so ordinary content is untouched — only true monsters
    /// clip. The collapsed one-line peek + the row's lazy Show-more still apply on top.
    static func truncateForDisplay(_ text: String, maxLines: Int = 400, maxChars: Int = 40_000) -> String {
        var out = text
        var clipped = false
        // Char cap first (bounds work before the line split on a huge single line).
        if out.count > maxChars {
            out = String(out.prefix(maxChars)); clipped = true
        }
        let lines = out.split(separator: "\n", omittingEmptySubsequences: false)
        if lines.count > maxLines {
            out = lines.prefix(maxLines).joined(separator: "\n"); clipped = true
        }
        return clipped ? out + "\n… (truncated — open in the dashboard for full output)" : out
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
