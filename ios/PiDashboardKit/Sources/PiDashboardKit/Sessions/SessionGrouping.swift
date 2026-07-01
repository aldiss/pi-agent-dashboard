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

    // MARK: - Secondary directory grouping (cc-ios-build owned)
    //
    // The seed shipped tier (primary) grouping only. SessionListView (§3) needs the
    // SECONDARY directory grouping the PWA's `groupSessionsByDirectory` provides —
    // pinned dirs first (in pin order), worktree sessions folded under their parent
    // repo via `groupCwd`, each group internally sorted by server order. Ported here
    // as owned core logic (path folding kept POSIX-simple — the dashboard server is
    // the operator's macOS host; Windows drive-letter folding is out of MVP scope).

    /// One directory subgroup within a tier. `pinned` drives the pin badge + ordering.
    public struct DirectoryGroup: Sendable, Equatable {
        public let cwd: String
        public let sessions: [DashboardSession]
        public let pinned: Bool
        public init(cwd: String, sessions: [DashboardSession], pinned: Bool) {
            self.cwd = cwd; self.sessions = sessions; self.pinned = pinned
        }
        /// Last path segment — the label the directory header shows.
        public var basename: String { cwd.split(separator: "/").last.map(String.init) ?? cwd }
    }

    /// Canonical key collapsing trailing-separator drift (POSIX, case-sensitive).
    static func pathKey(_ p: String) -> String {
        var s = p
        while s.count > 1 && s.hasSuffix("/") { s.removeLast() }
        return s
    }

    /// The directory a session groups under: worktree sessions fold to `groupCwd`,
    /// else `cwd` (mirrors `resolveSessionGroupPath`).
    public static func groupPath(_ session: DashboardSession) -> String {
        session.groupCwd ?? session.cwd ?? ""
    }

    /// Distinct directories the app already knows — every session's group path plus
    /// the pinned dirs — deduped by canonical path key and sorted by basename then
    /// full path. Feeds the "+ New session" spawn picker (spawn in a KNOWN dir only;
    /// the server-filesystem browser is deferred). Empty paths are dropped.
    public static func knownDirectories(sessions: [DashboardSession],
                                        pinned: [String] = []) -> [String] {
        var seen = Set<String>()
        var out: [String] = []
        for path in sessions.map(groupPath) + pinned {
            let trimmed = path.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty else { continue }
            let key = pathKey(trimmed)
            if seen.insert(key).inserted { out.append(trimmed) }
        }
        return out.sorted {
            let a = $0.split(separator: "/").last.map(String.init) ?? $0
            let b = $1.split(separator: "/").last.map(String.init) ?? $1
            return a == b ? $0 < $1 : a.localizedCaseInsensitiveCompare(b) == .orderedAscending
        }
    }

    /// Split sessions into directory subgroups: pinned dirs first (in pin order,
    /// including empty pinned dirs), then unpinned by most-recent activity. Each
    /// group's sessions are server-order sorted. Mirrors `groupSessionsByDirectory`.
    public static func groupByDirectory(_ sessions: [DashboardSession],
                                        orders: [String: [String]] = [:],
                                        pinnedDirectories: [String] = []) -> [DirectoryGroup] {
        let pinnedKeys = Set(pinnedDirectories.map(pathKey))
        // Bucket by canonical key, retaining first-seen display path.
        var order: [String] = []
        var byKey: [String: (cwd: String, sessions: [DashboardSession])] = [:]
        for s in sessions {
            let path = groupPath(s)
            let key = pathKey(path)
            if byKey[key] == nil { byKey[key] = (path, []); order.append(key) }
            byKey[key]!.sessions.append(s)
        }
        var result: [DirectoryGroup] = []
        // Pinned groups first, in pin order (zero-session pinned dirs included).
        for dir in pinnedDirectories {
            let key = pathKey(dir)
            let bucket = byKey[key]
            result.append(DirectoryGroup(
                cwd: dir,
                sessions: sortSessionsByOrder(bucket?.sessions ?? [], order: orders[dir] ?? orders[bucket?.cwd ?? ""]),
                pinned: true))
        }
        // Unpinned groups by most-recent activity (startedAt desc).
        let unpinned = order.compactMap { key -> DirectoryGroup? in
            guard !pinnedKeys.contains(key), let bucket = byKey[key] else { return nil }
            return DirectoryGroup(
                cwd: bucket.cwd,
                sessions: sortSessionsByOrder(bucket.sessions, order: orders[bucket.cwd]),
                pinned: false)
        }.sorted { a, b in
            (a.sessions.map { $0.startedAt ?? 0 }.max() ?? 0) > (b.sessions.map { $0.startedAt ?? 0 }.max() ?? 0)
        }
        return result + unpinned
    }

    /// Within ONE tier, produce directory subgroups when `folders` is on, else a
    /// single flat bucket (powers the Folders toggle). Mirrors `groupTierByFolder`.
    ///
    /// Pin handling: pinned dirs keep their ordering + badge for groups that have
    /// sessions in THIS tier, but zero-session pinned groups are dropped — a pinned
    /// directory is a sidebar-level concern and must not render as an empty folder
    /// in every tier (that left a large blank gap under each tier header).
    public static func groupTierByFolder(_ sessions: [DashboardSession], folders: Bool,
                                         orders: [String: [String]] = [:],
                                         pinnedDirectories: [String] = []) -> [DirectoryGroup] {
        if sessions.isEmpty { return [] }
        if !folders { return [DirectoryGroup(cwd: "", sessions: sessions, pinned: false)] }
        return groupByDirectory(sessions, orders: orders, pinnedDirectories: pinnedDirectories)
            .filter { !$0.sessions.isEmpty }
    }
}
