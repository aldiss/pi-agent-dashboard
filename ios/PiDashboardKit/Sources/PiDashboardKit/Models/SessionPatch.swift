import Foundation

/// A partial patch for a session, as carried by the WS `session_updated.updates`
/// field (`Partial<DashboardSession>`). Distinct from `DashboardSession` because
/// the patch has NO `id` (the id rides on the message's `sessionId`) and every
/// field is optional. `apply(to:)` merges the present fields onto an existing
/// session — the faithful semantics of a partial update.
public struct SessionPatch: Codable, Sendable, Equatable {
    public var name: String?
    public var status: String?
    public var model: String?
    public var thinkingLevel: String?
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
    public var currentTool: String?
    public var gitBranch: String?
    public var gitBranchUrl: String?
    public var gitPrNumber: Int?
    public var hidden: Bool?
    public var firstMessage: String?
    public var pid: Int?
    public var progress: DriverProgress?
    public var nextEngagement: DriverNextEngagement?
    public var processMetrics: ProcessMetrics?
    public var processes: [ProcessEntry]?
    public var worktree: Worktree?
    public var groupCwd: String?

    /// Apply present (non-nil) patch fields onto an existing session.
    public func apply(to s: inout DashboardSession) {
        if let v = name { s.name = v }
        if let v = status { s.status = v }
        if let v = model { s.model = v }
        if let v = thinkingLevel { s.thinkingLevel = v }
        if let v = endedAt { s.endedAt = v }
        if let v = lastActivityAt { s.lastActivityAt = v }
        if let v = unread { s.unread = v }
        if let v = resuming { s.resuming = v }
        if let v = tokensIn { s.tokensIn = v }
        if let v = tokensOut { s.tokensOut = v }
        if let v = cacheRead { s.cacheRead = v }
        if let v = cacheWrite { s.cacheWrite = v }
        if let v = cost { s.cost = v }
        if let v = contextTokens { s.contextTokens = v }
        if let v = contextWindow { s.contextWindow = v }
        if let v = currentTool { s.currentTool = v }
        if let v = gitBranch { s.gitBranch = v }
        if let v = gitBranchUrl { s.gitBranchUrl = v }
        if let v = gitPrNumber { s.gitPrNumber = v }
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
