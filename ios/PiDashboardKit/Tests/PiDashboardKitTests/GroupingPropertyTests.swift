import XCTest
@testable import PiDashboardKit

/// PROPERTY-style coverage of the session grouping / filter / sort surface — the
/// invariants that must hold across MANY generated inputs, plus the boundary cases
/// the seed `GroupingTests` / `DirectoryGroupingTests` don't pin. New file (no
/// collision): the seeds assert representative examples; this file asserts the
/// algebra (partition, idempotence, order-preservation, permutation-invariance).
final class GroupingPropertyTests: XCTestCase {

    // A deterministic spread of sessions across every tier + dir + status, built
    // without Date.now (stable seq) so the properties are reproducible.
    private func corpus() -> [DashboardSession] {
        var out: [DashboardSession] = []
        let dirs = ["/Users/op/proj-a", "/Users/op/proj-b", "/Users/op/.pi/cells/x/v1",
                    "/Users/op/.pi/orchestration-state/nos-cells/y-driver"]
        let crew = ["Joan", "Bert", "Peggy", "Lane"]
        for i in 0..<40 {
            var s = DashboardSession(
                id: "s\(i)",
                cwd: dirs[i % dirs.count],
                name: i % 5 == 0 ? crew[i % crew.count] : (i % 7 == 0 ? "subagent-worker-\(String(format: "%06x", i))" : "Cell\(i)Owl"),
                source: i % 3 == 0 ? "tui" : "tmux",
                status: ["active", "idle", "streaming", "ended"][i % 4],
                startedAt: Double(1_000 + i * 10),
                lastActivityAt: Double(1_000 + i * 10))
            s.hidden = (i % 11 == 0)
            out.append(s)
        }
        return out
    }

    // MARK: classifyTier is total + deterministic

    func testClassifyTierIsTotalAndStable() {
        for s in corpus() {
            let a = SessionGrouping.classifyTier(s)
            let b = SessionGrouping.classifyTier(s)
            XCTAssertEqual(a, b, "classifyTier deterministic for \(s.id)")
            XCTAssertTrue(SESSION_TIER_ORDER.contains(a), "every session lands in a known tier")
        }
    }

    // MARK: groupByTier partitions (no loss, no duplication, canonical order)

    func testGroupByTierIsAPartition() {
        let sessions = corpus()
        let groups = SessionGrouping.groupByTier(sessions)

        // No-loss + no-duplication: the multiset of ids across groups == input ids.
        let regrouped = groups.flatMap { $0.sessions.map { $0.id } }.sorted()
        XCTAssertEqual(regrouped, sessions.map { $0.id }.sorted(),
                       "every session appears exactly once across the tier groups")

        // Canonical order: emitted tiers are a subsequence of SESSION_TIER_ORDER.
        let emitted = groups.map { $0.tier }
        XCTAssertEqual(emitted, SESSION_TIER_ORDER.filter { t in emitted.contains(t) },
                       "tiers emitted in canonical order")

        // Each session is in the bucket its classifyTier dictates.
        for (tier, members) in groups {
            for m in members { XCTAssertEqual(SessionGrouping.classifyTier(m), tier) }
        }
        // No empty groups are emitted.
        XCTAssertFalse(groups.contains { $0.sessions.isEmpty })
    }

    func testGroupByTierIsPermutationInvariant() {
        let sessions = corpus()
        let shuffled = sessions.reversed() + []  // a deterministic non-identity permutation
        let a = SessionGrouping.groupByTier(sessions).map { ($0.tier, Set($0.sessions.map { $0.id })) }
        let b = SessionGrouping.groupByTier(Array(shuffled)).map { ($0.tier, Set($0.sessions.map { $0.id })) }
        XCTAssertEqual(a.map { $0.0 }, b.map { $0.0 }, "same tiers regardless of input order")
        for (x, y) in zip(a, b) { XCTAssertEqual(x.1, y.1, "same membership per tier") }
    }

    // MARK: filters are subset + idempotent

    func testFilterByQueryIsSubsetAndIdempotent() {
        let sessions = corpus()
        for q in ["cell", "joan", "proj", "worker", "", "  ", "zzz-nomatch"] {
            let once = SessionGrouping.filterByQuery(sessions, q)
            let twice = SessionGrouping.filterByQuery(once, q)
            XCTAssertEqual(once.map { $0.id }, twice.map { $0.id }, "filterByQuery idempotent for '\(q)'")
            XCTAssertTrue(Set(once.map { $0.id }).isSubset(of: Set(sessions.map { $0.id })),
                          "result is a subset for '\(q)'")
            // order-preserving: results keep input relative order.
            XCTAssertEqual(once.map { $0.id }, sessions.filter { s in once.contains { $0.id == s.id } }.map { $0.id })
        }
    }

    func testBlankQueryIsIdentity() {
        let sessions = corpus()
        XCTAssertEqual(SessionGrouping.filterByQuery(sessions, "").map { $0.id }, sessions.map { $0.id })
        XCTAssertEqual(SessionGrouping.filterByQuery(sessions, "   \n\t").map { $0.id }, sessions.map { $0.id })
    }

    func testFilterStaleMonotoneInThreshold() {
        let now = 10_000_000_000.0
        var sessions: [DashboardSession] = []
        for i in 0..<20 {
            sessions.append(DashboardSession(id: "s\(i)", status: i % 4 == 0 ? "ended" : "active",
                                             startedAt: now - Double(i) * 3600 * 1000,
                                             lastActivityAt: now - Double(i) * 3600 * 1000))
        }
        // Larger threshold ⇒ keeps a superset (more lenient never drops more).
        let small = Set(SessionGrouping.filterStale(sessions, staleHoursThreshold: 3, hideStale: true, now: now).map { $0.id })
        let large = Set(SessionGrouping.filterStale(sessions, staleHoursThreshold: 10, hideStale: true, now: now).map { $0.id })
        XCTAssertTrue(small.isSubset(of: large), "raising the stale threshold only keeps more")
        // hideStale=false is the identity.
        XCTAssertEqual(SessionGrouping.filterStale(sessions, staleHoursThreshold: 3, hideStale: false, now: now).count, sessions.count)
        // non-finite / non-positive threshold → passthrough (guard).
        XCTAssertEqual(SessionGrouping.filterStale(sessions, staleHoursThreshold: 0, hideStale: true, now: now).count, sessions.count)
        XCTAssertEqual(SessionGrouping.filterStale(sessions, staleHoursThreshold: .infinity, hideStale: true, now: now).count, sessions.count)
    }

    func testFilterSessionsActiveOnlyAndHidden() {
        let sessions = corpus()
        // activeOnly drops ended.
        let active = SessionGrouping.filterSessions(sessions, activeOnly: true, showHidden: true)
        XCTAssertFalse(active.contains { $0.status == "ended" })
        // showHidden=false drops hidden.
        let visible = SessionGrouping.filterSessions(sessions, activeOnly: false, showHidden: false)
        XCTAssertFalse(visible.contains { $0.hidden == true })
        // showHidden=true keeps hidden.
        let all = SessionGrouping.filterSessions(sessions, activeOnly: false, showHidden: true)
        XCTAssertEqual(all.count, sessions.count)
    }

    // MARK: sort + rank invariants

    func testSortByOrderIsPermutationAndPlacesOrderedFirst() {
        let sessions = corpus()
        let order = ["s30", "s10", "s0"]
        let sorted = SessionGrouping.sortSessionsByOrder(sessions, order: order)
        // permutation of the input.
        XCTAssertEqual(Set(sorted.map { $0.id }), Set(sessions.map { $0.id }))
        XCTAssertEqual(sorted.count, sessions.count)
        // the ordered ids come first, in order.
        XCTAssertEqual(Array(sorted.prefix(3)).map { $0.id }, order)
        // the remainder is startedAt-desc.
        let rest = Array(sorted.dropFirst(3))
        for (a, b) in zip(rest, rest.dropFirst()) {
            XCTAssertGreaterThanOrEqual(a.startedAt ?? 0, b.startedAt ?? 0, "unordered remainder is startedAt-desc")
        }
    }

    func testRankActiveFirstIsStablePartition() {
        let sessions = corpus()
        let ranked = SessionGrouping.rankActiveFirst(sessions)
        XCTAssertEqual(Set(ranked.map { $0.id }), Set(sessions.map { $0.id }), "permutation")
        // all non-ended precede all ended.
        let firstEnded = ranked.firstIndex { $0.status == "ended" } ?? ranked.count
        XCTAssertFalse(ranked.prefix(firstEnded).contains { $0.status == "ended" })
        XCTAssertTrue(ranked.dropFirst(firstEnded).allSatisfy { $0.status == "ended" })
        // stable: within each class, input relative order preserved.
        let aliveIn = sessions.filter { $0.status != "ended" }.map { $0.id }
        let aliveOut = ranked.filter { $0.status != "ended" }.map { $0.id }
        XCTAssertEqual(aliveIn, aliveOut, "stable within the alive class")
    }

    // MARK: directory grouping invariants

    func testGroupByDirectoryPartitionsAndFoldsWorktrees() {
        var sessions = corpus()
        // add a worktree session that must fold under proj-a.
        var wt = DashboardSession(id: "wt1", cwd: "/Users/op/proj-a/.worktrees/x", startedAt: 5000)
        wt.groupCwd = "/Users/op/proj-a"
        sessions.append(wt)
        let groups = SessionGrouping.groupByDirectory(sessions)
        // partition: every session appears once.
        let ids = groups.flatMap { $0.sessions.map { $0.id } }.sorted()
        XCTAssertEqual(ids, sessions.map { $0.id }.sorted())
        // the worktree folded under proj-a (same group as a proj-a cwd session).
        let projA = try? XCTUnwrap(groups.first { $0.cwd == "/Users/op/proj-a" })
        XCTAssertTrue(projA?.sessions.contains { $0.id == "wt1" } ?? false, "worktree folds to groupCwd")
    }

    func testPinnedDirsComeFirstInPinOrder() {
        let sessions = corpus()
        let pins = ["/Users/op/proj-b", "/Users/op/proj-a"]
        let groups = SessionGrouping.groupByDirectory(sessions, pinnedDirectories: pins)
        let pinnedPrefix = groups.prefix { $0.pinned }.map { $0.cwd }
        XCTAssertEqual(pinnedPrefix, pins, "pinned dirs lead, in pin order")
        XCTAssertTrue(groups.drop { $0.pinned }.allSatisfy { !$0.pinned }, "no pinned group after an unpinned one")
    }
}
