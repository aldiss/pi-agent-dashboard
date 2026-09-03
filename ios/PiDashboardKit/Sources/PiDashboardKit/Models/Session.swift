import Foundation

/// Source environment where a pi session is running.
/// Mirrors `SessionSource` in `packages/shared/src/types.ts`.
public enum SessionSource: String, Codable, Sendable {
    case tui, zed, tmux, dashboard, terminal
    case codex
    case claudeCode = "claude-code"
    case unknown
}

/// Current status of a session. Mirrors `SessionStatus`.
public enum SessionStatus: String, Codable, Sendable {
    case active, idle, streaming, ended
}

/// Runtime kind for a read-only tmux pane exposed by `/api/external-sessions`.
public enum ExternalRuntime: String, Codable, Sendable, Equatable {
    case codex
    case claudeCode = "claude-code"
}

/// Liveness state for an external pane. Ended panes retain their last capture.
public enum ExternalSessionState: String, Codable, Sendable, Equatable {
    case live, ended
}

/// Typed mirror of one entry in `GET /api/external-sessions`. Runtime-detail fields
/// remain optional because the live lightweight list can return identity fields only.
public struct ExternalSession: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let runtime: ExternalRuntime
    public let tmuxSession: String
    public let tmuxSocket: String
    public let title: String
    public let cwd: String?
    public let runtimePid: Int?
    public let state: ExternalSessionState?
    public let model: String?
    public let effort: String?
    public let firstSeenAt: Double?
    public let lastLiveAt: Double?
    public let endedAt: Double?
    public let output: String?
    public let outputAt: Double?
    public let outputChangedAt: Double?
    public let lineCount: Int?
}

/// Sanitized ownership metadata keyed by external tmux session name.
public struct ExternalSessionOwner: Codable, Sendable, Equatable {
    public let owner: String
    public let cell: String?
}

/// Canonical cell-driver identity returned beside external sessions.
public struct ExternalSessionDriver: Codable, Sendable, Equatable {
    public let realName: String
    public let tmux: String?
    public let cell: String?
}

/// Response envelope for `GET /api/external-sessions`.
/// Older/list-only servers omit ownership metadata, matching the web client's
/// compatibility defaults of an empty dictionary and array.
public struct ExternalSessionsResponse: Codable, Sendable, Equatable {
    public let sessions: [ExternalSession]
    public let owners: [String: ExternalSessionOwner]
    public let drivers: [ExternalSessionDriver]

    public init(sessions: [ExternalSession],
                owners: [String: ExternalSessionOwner] = [:],
                drivers: [ExternalSessionDriver] = []) {
        self.sessions = sessions
        self.owners = owners
        self.drivers = drivers
    }

    private enum CodingKeys: String, CodingKey { case sessions, owners, drivers }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        sessions = try container.decodeIfPresent([ExternalSession].self, forKey: .sessions) ?? []
        owners = try container.decodeIfPresent(
            [String: ExternalSessionOwner].self, forKey: .owners) ?? [:]
        drivers = try container.decodeIfPresent(
            [ExternalSessionDriver].self, forKey: .drivers) ?? []
    }
}

/// Structural marker carried by a mapped read-only external session.
public struct ExternalSessionMetadata: Codable, Sendable, Equatable {
    public let runtime: ExternalRuntime
    public let tmuxSession: String
    public let readOnly: Bool
    public let outputChangedAt: Double?
    public let lineCount: Int?

    public init(runtime: ExternalRuntime, tmuxSession: String, readOnly: Bool,
                outputChangedAt: Double? = nil, lineCount: Int? = nil) {
        self.runtime = runtime
        self.tmuxSession = tmuxSession
        self.readOnly = readOnly
        self.outputChangedAt = outputChangedAt
        self.lineCount = lineCount
    }
}

/// Operator effort the NEXT step of a driver needs — the next-engagement badge.
/// Mirrors `EngagementEffort` (ordered ascending by required operator effort).
public enum EngagementEffort: String, Codable, Sendable {
    case autonomous
    case oneAction = "one-action"
    case short
    case backAndForth = "back-and-forth"
}

/// Per-driver self-reported progress (dl-2620). Mirrors `DriverProgress`.
public struct DriverProgress: Codable, Sendable, Equatable {
    public var pct: Double
    public var label: String?
    public var milestonesDone: Double?
    public var milestonesTotal: Double?
    public init(pct: Double, label: String? = nil, milestonesDone: Double? = nil, milestonesTotal: Double? = nil) {
        self.pct = pct; self.label = label
        self.milestonesDone = milestonesDone; self.milestonesTotal = milestonesTotal
    }
}

/// Per-driver self-reported next-engagement effort + note. Mirrors `DriverNextEngagement`.
public struct DriverNextEngagement: Codable, Sendable, Equatable {
    public var effort: String
    public var note: String?
    public init(effort: String, note: String? = nil) {
        self.effort = effort; self.note = note
    }
}

/// Git worktree metadata. Mirrors `DashboardSession.worktree`.
public struct Worktree: Codable, Sendable, Equatable {
    public var branch: String
    public var path: String
    public init(branch: String, path: String) {
        self.branch = branch; self.path = path
    }
}

/// Latest process metrics from the pi agent. Mirrors `DashboardSession.processMetrics`.
public struct ProcessMetrics: Codable, Sendable, Equatable {
    public var rss: Double?
    public var heapUsed: Double?
    public var heapTotal: Double?
    public var cpuPercent: Double?
    public var eventLoopMaxMs: Double?
    public var loadAvg1m: Double?
    public var updatedAt: Double?
}

/// One active child process detected by the bridge process scanner. Faithful mirror
/// of an entry in `DashboardSession.processes` (`packages/shared/src/types.ts`):
/// `{ pid, pgid, command, elapsedMs }`. DISPLAY-ONLY in the native card — `pgid` is
/// carried for wire-fidelity but no kill action is wired this increment (parity B4).
public struct ProcessEntry: Codable, Sendable, Equatable, Identifiable {
    public var pid: Int
    public var pgid: Int
    public var command: String
    public var elapsedMs: Double
    public var id: Int { pid }

    public init(pid: Int, pgid: Int, command: String, elapsedMs: Double) {
        self.pid = pid; self.pgid = pgid; self.command = command; self.elapsedMs = elapsedMs
    }
}

/// A dashboard session representing a connected pi instance.
///
/// Faithful Codable mirror of `DashboardSession` in `packages/shared/src/types.ts`.
/// Every field except `id` is optional: the same struct backs both the full
/// session objects in `sessions_snapshot` / `/api/sessions` AND the partial
/// patches carried by `session_updated.updates`. Unknown JSON keys decode away
/// harmlessly (synthesized Codable ignores them), so the model can declare the
/// MVP-relevant subset and still decode real server payloads in full.
///
/// `source` / `status` are stored as raw `String` (faithful to the TS string
/// unions, forward-compatible with values the server may add); typed
/// convenience accessors expose the known enums.
public struct DashboardSession: Codable, Sendable, Identifiable, Equatable {
    public let id: String
    public var cwd: String?
    public var name: String?
    public var source: String?
    public var external: ExternalSessionMetadata?
    public var status: String?
    public var model: String?
    public var thinkingLevel: String?
    public var startedAt: Double?
    public var endedAt: Double?
    public var lastActivityAt: Double?
    public var unread: Bool?
    /// Server-driven resume-in-flight flag (set true by `handleResumeSession`, cleared
    /// on failure/timeout, and false once the respawned bridge re-registers). The
    /// native card reflects it as the "Resuming…" state.
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
    public var gitPrUrl: String?
    public var worktree: Worktree?
    public var groupCwd: String?
    public var hidden: Bool?
    public var firstMessage: String?
    public var sessionFile: String?
    public var sessionDir: String?
    public var pid: Int?
    public var bridgeConnected: Bool?
    public var progress: DriverProgress?
    public var nextEngagement: DriverNextEngagement?
    public var processMetrics: ProcessMetrics?
    /// Active child processes from the bridge scanner (display-only in the card).
    public var processes: [ProcessEntry]?

    public var sourceEnum: SessionSource? { source.flatMap(SessionSource.init(rawValue:)) }
    public var statusEnum: SessionStatus? { status.flatMap(SessionStatus.init(rawValue:)) }
    public var isEnded: Bool { status == "ended" }
    public var isExternal: Bool { external != nil }

    /// Display name the card shows — name → first line of firstMessage → last path
    /// segment of cwd. Mirrors `getSessionDisplayName`. The firstMessage fallback is
    /// reduced to its FIRST line (cc-ios-build improvement: a multi-line first prompt
    /// makes a broken multi-line card title; `filterByQuery` still searches the full
    /// firstMessage text, so search recall is unaffected).
    public var displayName: String {
        if let n = name?.trimmingCharacters(in: .whitespacesAndNewlines), !n.isEmpty { return n }
        if let f = firstMessage?.trimmingCharacters(in: .whitespacesAndNewlines), !f.isEmpty {
            let firstLine = f.split(separator: "\n", maxSplits: 1).first.map(String.init) ?? f
            return firstLine.trimmingCharacters(in: .whitespaces)
        }
        return cwd?.split(separator: "/").last.map(String.init) ?? id
    }

    /// Fraction of context window used (0...1), when both fields are present.
    public var contextFraction: Double? {
        guard let t = contextTokens, let w = contextWindow, w > 0 else { return nil }
        return min(max(t / w, 0), 1)
    }

    public init(id: String, cwd: String? = nil, name: String? = nil, source: String? = nil,
                status: String? = nil, startedAt: Double? = nil, lastActivityAt: Double? = nil,
                hidden: Bool? = nil, firstMessage: String? = nil, sessionFile: String? = nil,
                groupCwd: String? = nil) {
        self.id = id; self.cwd = cwd; self.name = name; self.source = source
        self.status = status; self.startedAt = startedAt; self.lastActivityAt = lastActivityAt
        self.hidden = hidden; self.firstMessage = firstMessage; self.sessionFile = sessionFile
        self.groupCwd = groupCwd
    }
}

/// Pure projection from the external-session payload into the ordinary card model.
/// `now` is injected so the `firstSeenAt` fallback stays deterministic in tests.
public enum ExternalSessionMapper {
    public static func map(_ session: ExternalSession, now: Double) -> DashboardSession {
        let startedAt = finiteTimestamp(session.firstSeenAt, fallback: now)
        let outputChangedAt = finiteTimestamp(session.outputChangedAt)
        let lastActivityAt = outputChangedAt
            ?? finiteTimestamp(session.lastLiveAt, fallback: startedAt)
        let endedAt = session.state == .ended
            ? finiteTimestamp(session.endedAt, fallback: lastActivityAt)
            : nil
        let trimmedModel = session.model?.trimmingCharacters(in: .whitespacesAndNewlines)
        let model = trimmedModel.flatMap { $0.isEmpty ? nil : $0 } ?? "unknown model"
        let trimmedEffort = session.effort?.trimmingCharacters(in: .whitespacesAndNewlines)
        let effort = trimmedEffort.flatMap { $0.isEmpty ? nil : $0 }

        var mapped = DashboardSession(
            id: session.id,
            cwd: session.cwd ?? "",
            name: session.title.isEmpty ? session.tmuxSession : session.title,
            source: session.runtime.rawValue,
            status: session.state == .ended ? "ended" : "active",
            startedAt: startedAt,
            lastActivityAt: lastActivityAt)
        mapped.model = "\(session.runtime.rawValue)/\(model)"
        mapped.thinkingLevel = effort
        mapped.endedAt = endedAt
        mapped.bridgeConnected = true
        mapped.pid = session.runtimePid
        mapped.external = ExternalSessionMetadata(
            runtime: session.runtime,
            tmuxSession: session.tmuxSession,
            readOnly: true,
            outputChangedAt: outputChangedAt,
            lineCount: session.lineCount)
        return mapped
    }

    private static func finiteTimestamp(_ value: Double?, fallback: Double) -> Double {
        guard let value, value.isFinite else { return fallback }
        return value
    }

    private static func finiteTimestamp(_ value: Double?) -> Double? {
        guard let value, value.isFinite else { return nil }
        return value
    }
}

/// Fail-soft external-session refresh policy plus the list-only merge boundary.
/// Networking stays injected so failure behavior is deterministic and unit-testable.
public enum ExternalSessionSource {
    public static let refreshInterval: Duration = .seconds(2)

    public static func refresh(
        current: [DashboardSession],
        now: Double,
        fetch: @Sendable () async throws -> ExternalSessionsResponse
    ) async -> [DashboardSession] {
        do {
            let response = try await fetch()
            return response.sessions.map { ExternalSessionMapper.map($0, now: now) }
        } catch {
            // Optional endpoint: retain the last good external snapshot. A cold failure
            // therefore contributes no rows and cannot disturb the pi-session list.
            return current
        }
    }

    public static func merge(
        piSessions: [DashboardSession],
        externalSessions: [DashboardSession]
    ) -> [DashboardSession] {
        piSessions + externalSessions
    }
}
