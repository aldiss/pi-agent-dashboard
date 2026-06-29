import Foundation

/// Coarse-grained role tier for sidebar primary grouping. Faithful port of
/// `SessionTier` in `packages/client/src/lib/session-grouping.ts`.
public enum SessionTier: String, Sendable, CaseIterable, Equatable {
    case standingCrew = "standing-crew"
    case drivers = "drivers"
    case cellExecutor = "cell-executor"
    case operatorChatPane = "operator-chat-pane"
    case worker = "worker"
    case other = "other"
}

/// Canonical tier display order (standing-crew → drivers → cell-executor →
/// operator-chat-pane → worker → other).
public let SESSION_TIER_ORDER: [SessionTier] = [
    .standingCrew, .drivers, .cellExecutor, .operatorChatPane, .worker, .other,
]

/// Pure session grouping / filtering / sorting — a faithful Swift port of the
/// pure helpers in `packages/client/src/lib/session-grouping.ts`. No UIKit /
/// SwiftUI; fully unit-testable via `swift test`.
public enum SessionGrouping {

    private static func matches(_ s: String, _ pattern: String, caseInsensitive: Bool = false) -> Bool {
        var opts: String.CompareOptions = [.regularExpression]
        if caseInsensitive { opts.insert(.caseInsensitive) }
        return s.range(of: pattern, options: opts) != nil
    }

    /// Classify a session into a `SessionTier`. Decision order matches the TS
    /// `classifyTier` exactly (first match wins).
    public static func classifyTier(_ session: DashboardSession) -> SessionTier {
        let name = session.name ?? ""
        if matches(name, "^subagent-worker-[0-9a-f]", caseInsensitive: true) { return .worker }
        if let f = session.sessionFile, matches(f, "/run-[0-9]+/session\\.jsonl$") { return .worker }
        if matches(name, "^(Bert|Joan|Peggy|Lane|Pete|Faye|Don|Alice)(?![A-Za-z])", caseInsensitive: true) {
            return .standingCrew
        }
        if session.source == "tui" { return .operatorChatPane }
        if session.source == "tmux" {
            let cwd = session.cwd ?? ""
            // pi-drivers (L2) live under nos-cells/ — keyed on cwd, NOT a themed-name regex,
            // because driver names are often single-word PascalCase or absent.
            if cwd.contains("nos-cells/") || (cwd.contains("-driver") && !cwd.contains("/.pi/cells/")) {
                return .drivers
            }
            if name.contains("cell-executor") { return .cellExecutor }
            if matches(name, "^[A-Z][a-z]+[A-Z][a-z]+") { // themed compound PascalCase
                let lower = name.lowercased()
                let inCellsCwd = (session.cwd ?? "").contains("/.pi/cells/")
                if lower.contains("cell") || lower.contains("ephemeral") || lower.contains("l2") || inCellsCwd {
                    return .cellExecutor
                }
            }
        }
        return .other
    }

    /// Group sessions by tier in canonical order; tiers with zero sessions omitted.
    public static func groupByTier(_ sessions: [DashboardSession]) -> [(tier: SessionTier, sessions: [DashboardSession])] {
        var buckets: [SessionTier: [DashboardSession]] = [:]
        for t in SESSION_TIER_ORDER { buckets[t] = [] }
        for s in sessions { buckets[classifyTier(s), default: []].append(s) }
        return SESSION_TIER_ORDER.compactMap { t in
            let arr = buckets[t] ?? []
            return arr.isEmpty ? nil : (t, arr)
        }
    }

    /// activeOnly → hidden filter pipeline. Mirrors `filterSessions`.
    public static func filterSessions(_ sessions: [DashboardSession], activeOnly: Bool, showHidden: Bool) -> [DashboardSession] {
        sessions.filter { s in
            if activeOnly && s.status == "ended" { return false }
            if (s.hidden ?? false) && !showHidden { return false }
            return true
        }
    }

    /// Hide stale-active sessions (status ≠ ended, no activity within threshold hours).
    /// Selected session always preserved. Mirrors `filterStaleSessions`.
    public static func filterStale(_ sessions: [DashboardSession], staleHoursThreshold: Double,
                                   hideStale: Bool, now: Double, selectedId: String? = nil) -> [DashboardSession] {
        if !hideStale { return sessions }
        if !staleHoursThreshold.isFinite || staleHoursThreshold <= 0 { return sessions }
        let cutoff = now - staleHoursThreshold * 3600 * 1000
        return sessions.filter { s in
            if s.id == selectedId { return true }
            if s.status == "ended" { return true }
            let lastActivity = max(s.lastActivityAt ?? 0, s.startedAt ?? 0)
            return lastActivity >= cutoff
        }
    }

    /// Case-insensitive substring search over the string the card actually shows
    /// (name → firstMessage → cwd basename). Mirrors `filterByQuery`.
    public static func filterByQuery(_ sessions: [DashboardSession], _ query: String) -> [DashboardSession] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if q.isEmpty { return sessions }
        return sessions.filter { s in
            if let name = s.name?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty {
                return name.lowercased().contains(q)
            }
            if let fm = s.firstMessage?.trimmingCharacters(in: .whitespacesAndNewlines), !fm.isEmpty {
                return fm.lowercased().contains(q)
            }
            let basename = s.cwd?.split(separator: "/").last.map(String.init) ?? ""
            return basename.lowercased().contains(q)
        }
    }

    /// Sort by server order, then startedAt descending for unordered. Mirrors `sortSessionsByOrder`.
    public static func sortSessionsByOrder(_ sessions: [DashboardSession], order: [String]?) -> [DashboardSession] {
        guard let order = order, !order.isEmpty else {
            return sessions.sorted { ($0.startedAt ?? 0) > ($1.startedAt ?? 0) }
        }
        var index: [String: Int] = [:]
        for (i, id) in order.enumerated() { index[id] = i }
        var ordered: [DashboardSession] = []
        var unordered: [DashboardSession] = []
        for s in sessions { if index[s.id] != nil { ordered.append(s) } else { unordered.append(s) } }
        ordered.sort { index[$0.id]! < index[$1.id]! }
        unordered.sort { ($0.startedAt ?? 0) > ($1.startedAt ?? 0) }
        return ordered + unordered
    }

    /// Stable rank: alive sessions above ended, preserving relative order. Mirrors `rankActiveFirst`.
    public static func rankActiveFirst(_ sessions: [DashboardSession]) -> [DashboardSession] {
        sessions.enumerated().sorted { a, b in
            let aEnded = a.element.status == "ended" ? 1 : 0
            let bEnded = b.element.status == "ended" ? 1 : 0
            if aEnded != bEnded { return aEnded < bEnded }
            return a.offset < b.offset
        }.map { $0.element }
    }
}
