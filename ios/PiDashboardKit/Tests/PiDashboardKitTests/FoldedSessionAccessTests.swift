import XCTest
@testable import PiDashboardKit

final class FoldedSessionAccessTests: XCTestCase {
    private func session(_ id: String, name: String = "Joan", cwd: String = "/a",
                         lastActivityAt: Double? = nil,
                         startedAt: Double? = nil) -> DashboardSession {
        DashboardSession(id: id, cwd: cwd, name: name,
                         startedAt: startedAt, lastActivityAt: lastActivityAt)
    }

    private func row(survivor: DashboardSession, olderIds: [String],
                     olderCount: Int? = nil) -> SessionGrouping.CollapsedSession {
        SessionGrouping.CollapsedSession(
            session: survivor,
            olderCount: olderCount ?? olderIds.count,
            olderIds: olderIds)
    }

    func testFoldedSessionsResolvesOlderIdsNewestFirst() {
        let survivor = session("survivor", lastActivityAt: 400)
        let registry = [
            "a": session("a", lastActivityAt: 100),
            "b": session("b", lastActivityAt: 300),
            "c": session("c", lastActivityAt: 200),
        ]

        let resolved = SessionGrouping.foldedSessions(
            row(survivor: survivor, olderIds: ["a", "b", "c"]), registry: registry)

        XCTAssertEqual(resolved.map(\.id), ["b", "c", "a"])
    }

    func testFoldedSessionsDropsUnknownIds() {
        let known = session("known", lastActivityAt: 100)
        let resolved = SessionGrouping.foldedSessions(
            row(survivor: session("survivor"), olderIds: ["missing", "known"]),
            registry: ["known": known])

        XCTAssertEqual(resolved.map(\.id), ["known"])
    }

    func testFoldedSessionsEmptyForUnfoldedRow() {
        let resolved = SessionGrouping.foldedSessions(
            row(survivor: session("survivor"), olderIds: []),
            registry: ["survivor": session("survivor")])

        XCTAssertTrue(resolved.isEmpty)
    }

    func testFoldedSessionsTieBreakIsIdDescending() {
        let registry = [
            "aaa": session("aaa", lastActivityAt: 100),
            "zzz": session("zzz", lastActivityAt: 100),
        ]
        let resolved = SessionGrouping.foldedSessions(
            row(survivor: session("survivor"), olderIds: ["aaa", "zzz"]),
            registry: registry)

        XCTAssertEqual(resolved.map(\.id), ["zzz", "aaa"])
    }

    func testBadgeCountEqualsReachableSessionCount() {
        let input = [
            session("j-old", name: "Joan-tenure-1", cwd: "/a", lastActivityAt: 100),
            session("j-new", name: "Joan-tenure-2", cwd: "/a", lastActivityAt: 300),
            session("c-old", name: "Cartographer", cwd: "/b", lastActivityAt: 100),
            session("c-mid", name: "Cartographer", cwd: "/b", lastActivityAt: 200),
            session("c-new", name: "Cartographer", cwd: "/b", lastActivityAt: 300),
            session("p", name: "Pete", cwd: "/c", lastActivityAt: 400),
        ]
        let registry = Dictionary(uniqueKeysWithValues: input.map { ($0.id, $0) })
        let rows = SessionGrouping.collapseGroups(
            SessionGrouping.groupTierByFolder(input, folders: true)).flatMap(\.rows)

        for collapsed in rows {
            XCTAssertEqual(
                SessionGrouping.foldedSessions(collapsed, registry: registry).count,
                collapsed.olderCount,
                "the +N badge must equal the number of sessions the expander reveals")
        }
    }

    func testFoldedSessionsNeverReturnsSurvivor() {
        let survivor = session("survivor", lastActivityAt: 300)
        let older = session("older", lastActivityAt: 100)
        let resolved = SessionGrouping.foldedSessions(
            row(survivor: survivor, olderIds: ["survivor", "older"], olderCount: 1),
            registry: ["survivor": survivor, "older": older])

        XCTAssertEqual(resolved.map(\.id), ["older"])
        XCTAssertFalse(resolved.contains { $0.id == survivor.id },
                       "the survivor must not be reachable twice")
    }
}
