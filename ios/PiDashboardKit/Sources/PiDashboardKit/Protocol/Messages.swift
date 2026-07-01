import Foundation

/// Server → Browser WebSocket messages (the subset the native client consumes).
/// Faithful to `ServerToBrowserMessage` in `packages/shared/src/browser-protocol.ts`.
/// Unhandled message types decode to `.unknown(type:)` rather than throwing, so a
/// server that emits a richer protocol never breaks the client (additive contract).
public enum ServerMessage: Sendable {
    case sessionsSnapshot(sessions: [DashboardSession], orders: [String: [String]])
    case sessionAdded(session: DashboardSession, spawnRequestId: String?)
    case sessionUpdated(sessionId: String, updates: SessionPatch)
    case sessionRemoved(sessionId: String)
    case sessionsReordered(cwd: String, sessionIds: [String])
    case event(sessionId: String, seq: Int, event: DashboardEvent)
    case eventReplay(sessionId: String, events: [SequencedEvent], isLast: Bool)
    case pinnedDirsUpdated(paths: [String])
    case sendPromptFailed(sessionId: String, queueNonce: String?, reason: String?)
    case sessionStateReset(sessionId: String)
    case modelsList(sessionId: String, models: [ModelInfo])
    case unknown(type: String)

    /// The wire `type` discriminator (for routing / logging).
    public var wireType: String {
        switch self {
        case .sessionsSnapshot: return "sessions_snapshot"
        case .sessionAdded: return "session_added"
        case .sessionUpdated: return "session_updated"
        case .sessionRemoved: return "session_removed"
        case .sessionsReordered: return "sessions_reordered"
        case .event: return "event"
        case .eventReplay: return "event_replay"
        case .pinnedDirsUpdated: return "pinned_dirs_updated"
        case .sendPromptFailed: return "send_prompt_failed"
        case .sessionStateReset: return "session_state_reset"
        case .modelsList: return "models_list"
        case .unknown(let t): return t
        }
    }
}

extension ServerMessage: Decodable {
    private enum K: String, CodingKey {
        case type, sessions, orders, session, spawnRequestId, sessionId, updates
        case seq, event, events, isLast, cwd, sessionIds, paths, queueNonce, reason, models
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        let type = try c.decode(String.self, forKey: .type)
        switch type {
        case "sessions_snapshot":
            self = .sessionsSnapshot(
                sessions: try c.decodeIfPresent([DashboardSession].self, forKey: .sessions) ?? [],
                orders: try c.decodeIfPresent([String: [String]].self, forKey: .orders) ?? [:])
        case "session_added":
            self = .sessionAdded(
                session: try c.decode(DashboardSession.self, forKey: .session),
                spawnRequestId: try c.decodeIfPresent(String.self, forKey: .spawnRequestId))
        case "session_updated":
            self = .sessionUpdated(
                sessionId: try c.decode(String.self, forKey: .sessionId),
                updates: try c.decode(SessionPatch.self, forKey: .updates))
        case "session_removed":
            self = .sessionRemoved(sessionId: try c.decode(String.self, forKey: .sessionId))
        case "sessions_reordered":
            self = .sessionsReordered(
                cwd: try c.decode(String.self, forKey: .cwd),
                sessionIds: try c.decodeIfPresent([String].self, forKey: .sessionIds) ?? [])
        case "event":
            self = .event(
                sessionId: try c.decode(String.self, forKey: .sessionId),
                seq: try c.decode(Int.self, forKey: .seq),
                event: try c.decode(DashboardEvent.self, forKey: .event))
        case "event_replay":
            self = .eventReplay(
                sessionId: try c.decode(String.self, forKey: .sessionId),
                events: try c.decodeIfPresent([SequencedEvent].self, forKey: .events) ?? [],
                isLast: try c.decodeIfPresent(Bool.self, forKey: .isLast) ?? true)
        case "pinned_dirs_updated":
            self = .pinnedDirsUpdated(paths: try c.decodeIfPresent([String].self, forKey: .paths) ?? [])
        case "send_prompt_failed":
            self = .sendPromptFailed(
                sessionId: try c.decode(String.self, forKey: .sessionId),
                queueNonce: try c.decodeIfPresent(String.self, forKey: .queueNonce),
                reason: try c.decodeIfPresent(String.self, forKey: .reason))
        case "session_state_reset":
            self = .sessionStateReset(sessionId: try c.decode(String.self, forKey: .sessionId))
        case "models_list":
            self = .modelsList(
                sessionId: try c.decode(String.self, forKey: .sessionId),
                models: try c.decodeIfPresent([ModelInfo].self, forKey: .models) ?? [])
        default:
            self = .unknown(type: type)
        }
    }
}

/// Browser → Server WebSocket messages (the subset the native client sends).
/// Faithful to `BrowserToServerMessage` in `packages/shared/src/browser-protocol.ts`.
public enum ClientMessage: Sendable, Encodable {
    case subscribe(sessionId: String, lastSeq: Int?)
    case unsubscribe(sessionId: String)
    case sendPrompt(sessionId: String, text: String, images: [ImageContent]?, queueNonce: String?)
    case abort(sessionId: String)
    case sessionView(sessionId: String)
    case sessionUnview(sessionId: String)
    case renameSession(sessionId: String, name: String)
    case setModel(sessionId: String, provider: String, modelId: String)
    case setThinkingLevel(sessionId: String, level: String)
    case requestModels(sessionId: String)
    case resumeSession(sessionId: String, mode: String, requestId: String?)
    case hideSession(sessionId: String)
    case unhideSession(sessionId: String)
    case shutdown(sessionId: String)
    case forceKill(sessionId: String)
    case spawnSession(cwd: String, requestId: String?)

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: DynamicKey.self)
        // All `put` call sites carry only string fields; the messages with
        // non-string fields (subscribe/sendPrompt/resumeSession) are encoded inline.
        func put(_ type: String, _ pairs: [(String, String)]) throws {
            try c.encode(type, forKey: DynamicKey("type"))
            for (k, v) in pairs { try c.encode(v, forKey: DynamicKey(k)) }
        }
        switch self {
        case .subscribe(let sid, let last):
            try c.encode("subscribe", forKey: DynamicKey("type"))
            try c.encode(sid, forKey: DynamicKey("sessionId"))
            try c.encodeIfPresent(last, forKey: DynamicKey("lastSeq"))
        case .unsubscribe(let sid): try put("unsubscribe", [("sessionId", sid)])
        case .sendPrompt(let sid, let text, let images, let nonce):
            try c.encode("send_prompt", forKey: DynamicKey("type"))
            try c.encode(sid, forKey: DynamicKey("sessionId"))
            try c.encode(text, forKey: DynamicKey("text"))
            try c.encodeIfPresent(images, forKey: DynamicKey("images"))
            try c.encodeIfPresent(nonce, forKey: DynamicKey("queueNonce"))
        case .abort(let sid): try put("abort", [("sessionId", sid)])
        case .sessionView(let sid): try put("session_view", [("sessionId", sid)])
        case .sessionUnview(let sid): try put("session_unview", [("sessionId", sid)])
        case .renameSession(let sid, let name): try put("rename_session", [("sessionId", sid), ("name", name)])
        case .setModel(let sid, let provider, let modelId):
            try put("set_model", [("sessionId", sid), ("provider", provider), ("modelId", modelId)])
        case .setThinkingLevel(let sid, let level): try put("set_thinking_level", [("sessionId", sid), ("level", level)])
        case .requestModels(let sid): try put("request_models", [("sessionId", sid)])
        case .resumeSession(let sid, let mode, let reqId):
            try c.encode("resume_session", forKey: DynamicKey("type"))
            try c.encode(sid, forKey: DynamicKey("sessionId"))
            try c.encode(mode, forKey: DynamicKey("mode"))
            try c.encodeIfPresent(reqId, forKey: DynamicKey("requestId"))
        case .hideSession(let sid): try put("hide_session", [("sessionId", sid)])
        case .unhideSession(let sid): try put("unhide_session", [("sessionId", sid)])
        case .shutdown(let sid): try put("shutdown", [("sessionId", sid)])
        case .forceKill(let sid): try put("force_kill", [("sessionId", sid)])
        case .spawnSession(let cwd, let reqId):
            // The one client message keyed by `cwd`, not `sessionId` — the server
            // spawns a fresh pi in that directory (SpawnSessionBrowserMessage).
            try c.encode("spawn_session", forKey: DynamicKey("type"))
            try c.encode(cwd, forKey: DynamicKey("cwd"))
            try c.encodeIfPresent(reqId, forKey: DynamicKey("requestId"))
        }
    }

    /// Serialize to a UTF-8 JSON string for the WS text frame.
    public func jsonString() throws -> String {
        let data = try JSONEncoder().encode(self)
        return String(decoding: data, as: UTF8.self)
    }
}
