import Foundation

/// A patch field's THREE states (Cluster 6). Synthesized `Codable` collapses JSON
/// `null` and an ABSENT key both to `.none` — so a server clearing a value (name /
/// PR / model → `null`) could never actually clear it, only absent-no-op. This
/// tri-state distinguishes them:
///   - `.absent`     the key was missing → leave the target unchanged
///   - `.cleared`    the key was present and `null` → set the target to nil
///   - `.value(T)`   the key carried a value → set the target
public enum PatchField<T: Equatable & Sendable>: Sendable, Equatable {
    case absent
    case cleared
    case value(T)

    /// Decode from a keyed container, distinguishing absent / null / value. A garbled
    /// value (wrong type) degrades to `.absent` (Cluster 6 resilience — never throw).
    static func decode<K: CodingKey>(_ type: T.Type, from c: KeyedDecodingContainer<K>,
                                     forKey key: K) -> PatchField<T> where T: Decodable {
        guard c.contains(key) else { return .absent }
        if (try? c.decodeNil(forKey: key)) == true { return .cleared }
        if let v = try? c.decode(T.self, forKey: key) { return .value(v) }
        return .absent // present but un-decodable → treat as no-op, don't throw
    }
}

/// A partial patch for a session, as carried by the WS `session_updated.updates`
/// field (`Partial<DashboardSession>`). Distinct from `DashboardSession` because
/// the patch has NO `id` (the id rides on the message's `sessionId`). `apply(to:)`
/// merges present fields onto an existing session.
///
/// Cluster 6: the CLEARABLE fields (name, model, thinkingLevel, gitBranch,
/// gitBranchUrl, gitPrNumber, currentTool) are `PatchField` tri-states so a server
/// `null` genuinely CLEARS them (PR closed → gitPrNumber:null → PR badge disappears),
/// while absent leaves them untouched. The value-only fields (status/tokens/cost/…)
/// stay plain `Optional` — a `null` there is just "absent" (they're never
/// meaningfully cleared to nil in the protocol). Context tokens/window are the
/// exception: they form one measurement and apply atomically when either is present.
public struct SessionPatch: Sendable, Equatable {
    // Clearable (tri-state).
    public var name: PatchField<String>
    public var model: PatchField<String>
    public var thinkingLevel: PatchField<String>
    public var gitBranch: PatchField<String>
    public var gitBranchUrl: PatchField<String>
    public var gitPrNumber: PatchField<Int>
    public var currentTool: PatchField<String>
    // Value-only (present → set; absent/null → no-op).
    public var status: String?
    public var endedAt: Double?
    public var lastActivityAt: Double?
    public var unread: Bool?
    public var resuming: Bool?
    public var tokensIn: Double?
    public var tokensOut: Double?
    public var cacheRead: Double?
    public var cacheWrite: Double?
    public var cost: Double?
    public var contextTokens: Double?
    public var contextWindow: Double?
    public var hidden: Bool?
    public var firstMessage: String?
    public var pid: Int?
    public var progress: DriverProgress?
    public var nextEngagement: DriverNextEngagement?
    public var processMetrics: ProcessMetrics?
    public var processes: [ProcessEntry]?
    public var worktree: Worktree?
    public var groupCwd: String?
    /// Decoder-level presence survives Optional's absent/null collapse so an
    /// incomplete or cleared measurement can invalidate an older pair.
    private var hasContextUpdate: Bool

    /// Apply present patch fields onto an existing session. Tri-state clearable fields
    /// clear on `.cleared`, set on `.value`, no-op on `.absent`.
    public func apply(to s: inout DashboardSession) {
        name.applyClearable(to: &s.name)
        model.applyClearable(to: &s.model)
        thinkingLevel.applyClearable(to: &s.thinkingLevel)
        gitBranch.applyClearable(to: &s.gitBranch)
        gitBranchUrl.applyClearable(to: &s.gitBranchUrl)
        gitPrNumber.applyClearable(to: &s.gitPrNumber)
        currentTool.applyClearable(to: &s.currentTool)
        if let v = status { s.status = v }
        if let v = endedAt { s.endedAt = v }
        if let v = lastActivityAt { s.lastActivityAt = v }
        if let v = unread { s.unread = v }
        if let v = resuming { s.resuming = v }
        if let v = tokensIn { s.tokensIn = v }
        if let v = tokensOut { s.tokensOut = v }
        if let v = cacheRead { s.cacheRead = v }
        if let v = cacheWrite { s.cacheWrite = v }
        if let v = cost { s.cost = v }
        // Never combine fresh context usage with a window retained from another
        // update/model. A partial measurement preserves its supplied half but
        // invalidates the missing half, making contextFraction unknown.
        if hasContextUpdate || contextTokens != nil || contextWindow != nil {
            s.contextTokens = contextTokens
            s.contextWindow = contextWindow
        }
        if let v = hidden { s.hidden = v }
        if let v = firstMessage { s.firstMessage = v }
        if let v = pid { s.pid = v }
        if let v = progress { s.progress = v }
        if let v = nextEngagement { s.nextEngagement = v }
        if let v = processMetrics { s.processMetrics = v }
        if let v = processes { s.processes = v }
        if let v = worktree { s.worktree = v }
        if let v = groupCwd { s.groupCwd = v }
    }
}

private extension PatchField {
    /// Apply this tri-state onto an optional target: `.value`→set, `.cleared`→nil,
    /// `.absent`→unchanged.
    func applyClearable(to target: inout T?) {
        switch self {
        case .value(let v): target = v
        case .cleared:      target = nil
        case .absent:       break
        }
    }
}

extension SessionPatch: Decodable {
    private enum K: String, CodingKey {
        case name, model, thinkingLevel, gitBranch, gitBranchUrl, gitPrNumber, currentTool
        case status, endedAt, lastActivityAt, unread, resuming, tokensIn, tokensOut
        case cacheRead, cacheWrite, cost, contextTokens, contextWindow, hidden
        case firstMessage, pid, progress, nextEngagement, processMetrics, processes
        case worktree, groupCwd
    }

    public init(from decoder: Decoder) throws {
        // Missing container (garbled object) → an empty (all-absent) patch, never a throw.
        guard let c = try? decoder.container(keyedBy: K.self) else {
            self = SessionPatch(); return
        }
        // Clearable tri-states.
        name = PatchField.decode(String.self, from: c, forKey: .name)
        model = PatchField.decode(String.self, from: c, forKey: .model)
        thinkingLevel = PatchField.decode(String.self, from: c, forKey: .thinkingLevel)
        gitBranch = PatchField.decode(String.self, from: c, forKey: .gitBranch)
        gitBranchUrl = PatchField.decode(String.self, from: c, forKey: .gitBranchUrl)
        gitPrNumber = PatchField.decode(Int.self, from: c, forKey: .gitPrNumber)
        currentTool = PatchField.decode(String.self, from: c, forKey: .currentTool)
        // Value-only fields — a garbled field degrades to nil (Cluster 6), never throws.
        func opt<V: Decodable>(_ key: K) -> V? { (try? c.decodeIfPresent(V.self, forKey: key)) ?? nil }
        hasContextUpdate = c.contains(.contextTokens) || c.contains(.contextWindow)
        status = opt(.status); endedAt = opt(.endedAt); lastActivityAt = opt(.lastActivityAt)
        unread = opt(.unread); resuming = opt(.resuming); tokensIn = opt(.tokensIn)
        tokensOut = opt(.tokensOut); cacheRead = opt(.cacheRead); cacheWrite = opt(.cacheWrite)
        cost = opt(.cost); contextTokens = opt(.contextTokens); contextWindow = opt(.contextWindow)
        hidden = opt(.hidden); firstMessage = opt(.firstMessage); pid = opt(.pid)
        progress = opt(.progress); nextEngagement = opt(.nextEngagement)
        processMetrics = opt(.processMetrics); processes = opt(.processes)
        worktree = opt(.worktree); groupCwd = opt(.groupCwd)
    }
}

extension SessionPatch {
    /// Empty patch (all fields absent / nil) — the fallback + a test seed.
    public init() {
        name = .absent; model = .absent; thinkingLevel = .absent; gitBranch = .absent
        gitBranchUrl = .absent; gitPrNumber = .absent; currentTool = .absent
        status = nil; endedAt = nil; lastActivityAt = nil; unread = nil; resuming = nil
        tokensIn = nil; tokensOut = nil; cacheRead = nil; cacheWrite = nil; cost = nil
        contextTokens = nil; contextWindow = nil; hidden = nil; firstMessage = nil; pid = nil
        progress = nil; nextEngagement = nil; processMetrics = nil; processes = nil
        worktree = nil; groupCwd = nil
        hasContextUpdate = false
    }
}
