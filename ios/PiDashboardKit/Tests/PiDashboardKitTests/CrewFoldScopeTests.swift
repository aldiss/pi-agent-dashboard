import XCTest
@testable import PiDashboardKit

final class CrewFoldScopeTests: XCTestCase {
    private func session(_ id: String, name: String? = nil, cwd: String? = nil,
                         groupCwd: String? = nil,
                         lastActivityAt: Double? = nil) -> DashboardSession {
        DashboardSession(id: id, cwd: cwd, name: name,
                         lastActivityAt: lastActivityAt, groupCwd: groupCwd)
    }

    private func collapse(_ groups: [SessionGrouping.DirectoryGroup],
                          selectedId: String? = nil) -> [SessionGrouping.CollapsedDirectoryGroup] {
        SessionGrouping.collapseGroups(groups, selectedId: selectedId)
    }

    func testCrewNameInTwoDirectoriesRendersTwoRows() {
        let sessions = [
            session("a", name: "Pete", cwd: "/a", lastActivityAt: 100),
            session("b", name: "Pete", cwd: "/b", lastActivityAt: 200),
        ]

        let out = collapse(SessionGrouping.groupTierByFolder(sessions, folders: true))

        XCTAssertEqual(out.count, 2)
        XCTAssertEqual(out.map(\.rows.count), [1, 1])
        XCTAssertTrue(out.flatMap(\.rows).allSatisfy { $0.olderCount == 0 })
    }

    func testCrewNameInTwoDirectoriesSurvivesFoldersOff() {
        let sessions = [
            session("a", name: "Pete", cwd: "/a", lastActivityAt: 100),
            session("b", name: "Pete", cwd: "/b", lastActivityAt: 200),
        ]

        let out = collapse(SessionGrouping.groupTierByFolder(sessions, folders: false))

        XCTAssertEqual(out.flatMap(\.rows).count, 2)
        XCTAssertTrue(out.flatMap(\.rows).allSatisfy { $0.olderCount == 0 })
    }

    func testTenuresInOneDirectoryStillFold() {
        let tenures = [
            session("j1", name: "Joan-tenure-1", cwd: "/a", lastActivityAt: 100),
            session("j2", name: "Joan-tenure-2", cwd: "/a", lastActivityAt: 300),
            session("j3", name: "Joan-tenure-3", cwd: "/a", lastActivityAt: 200),
        ]

        let out = collapse(SessionGrouping.groupTierByFolder(tenures, folders: true))

        XCTAssertEqual(out.flatMap(\.rows).count, 1)
        XCTAssertEqual(out[0].rows[0].session.id, "j2")
        XCTAssertEqual(out[0].rows[0].olderCount, 2)
    }

    func testSelectedTenurePromotedWithinItsGroup() {
        let tenures = [
            session("j-new", name: "Joan-tenure-2", cwd: "/a", lastActivityAt: 300),
            session("j-old", name: "Joan-tenure-1", cwd: "/a", lastActivityAt: 100),
        ]

        let out = collapse(
            SessionGrouping.groupTierByFolder(tenures, folders: true),
            selectedId: "j-old")

        XCTAssertEqual(out.flatMap(\.rows).count, 1)
        XCTAssertEqual(out[0].rows[0].session.id, "j-old")
        XCTAssertEqual(out[0].rows[0].olderCount, 1)
        XCTAssertEqual(out[0].rows[0].olderIds, ["j-new"])
    }

    func testRowsNeedingDirectoryLabelFlagsOnlySharedNames() {
        let sessions = [
            session("p-a", name: "Pete", cwd: "/a", lastActivityAt: 100),
            session("p-b", name: "Pete", cwd: "/b", lastActivityAt: 200),
            session("c", name: "Cartographer", cwd: "/c", lastActivityAt: 300),
        ]
        let groups = collapse(SessionGrouping.groupTierByFolder(sessions, folders: true))

        XCTAssertEqual(SessionGrouping.rowsNeedingDirectoryLabel(groups), ["p-a", "p-b"])
    }

    func testRowsNeedingDirectoryLabelEmptyWhenAllNamesDistinct() {
        let sessions = [
            session("p", name: "Pete", cwd: "/a"),
            session("c", name: "Cartographer", cwd: "/b"),
            session("n", name: "Navigator", cwd: "/c"),
        ]
        let groups = collapse(SessionGrouping.groupTierByFolder(sessions, folders: true))

        XCTAssertTrue(SessionGrouping.rowsNeedingDirectoryLabel(groups).isEmpty)
    }

    func testCollapsingIsNotDisabledWholesale() {
        let tenures = (1...23).map {
            session("j\($0)", name: "Joan-tenure-\($0)", cwd: "/orch",
                    lastActivityAt: Double($0) * 10)
        }

        let out = collapse(SessionGrouping.groupTierByFolder(tenures, folders: true))

        XCTAssertEqual(out.flatMap(\.rows).count, 1,
                       "23 same-seat tenures in one cwd fold to ONE row")
        XCTAssertEqual(out[0].rows[0].olderCount, 22)
    }

    func testEveryInputSessionIsEitherVisibleOrFolded() {
        let input = [
            session("p-a", name: "Pete", cwd: "/a", lastActivityAt: 100),
            session("p-b", name: "Pete-tenure-2", cwd: "/b", lastActivityAt: 200),
            session("j-old", name: "Joan-tenure-1", cwd: "/orch", lastActivityAt: 10),
            session("j-new", name: "Joan-tenure-2", cwd: "/orch", lastActivityAt: 20),
            session("c-old", name: "Cartographer", cwd: "/c", lastActivityAt: 30),
            session("c-new", name: "Cartographer", cwd: "/c", lastActivityAt: 40),
            session("c-other", name: "Cartographer", cwd: "/d", lastActivityAt: 50),
            session("wt-old", name: "Navigator", cwd: "/repo/.worktrees/one",
                    groupCwd: "/repo", lastActivityAt: 60),
            session("wt-new", name: "Navigator", cwd: "/repo/.worktrees/two",
                    groupCwd: "/repo", lastActivityAt: 70),
            session("anonymous", cwd: "/e", lastActivityAt: 80),
        ]

        let out = collapse(SessionGrouping.groupTierByFolder(input, folders: true))
        let visible = Set(out.flatMap(\.rows).map(\.session.id))
        let folded = Set(out.flatMap(\.rows).flatMap(\.olderIds))

        XCTAssertEqual(visible.union(folded), Set(input.map(\.id)),
                       "every session is a visible row or is folded behind one")
        XCTAssertTrue(visible.isDisjoint(with: folded), "no session is both")
    }
}
