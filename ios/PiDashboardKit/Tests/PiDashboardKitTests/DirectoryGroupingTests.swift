import XCTest
@testable import PiDashboardKit

/// Tests for the secondary directory-grouping logic added by cc-ios-build
/// (pinned-first, groupCwd-folded, server-order-sorted). Co-located with the
/// build session's owned `groupByDirectory` / `groupTierByFolder`. Comprehensive
/// grouping coverage lives in the test CC's suite.
final class DirectoryGroupingTests: XCTestCase {

    func testGroupByDirectory_bucketsByCwd() {
        let sessions: [DashboardSession] = [
            .init(id: "a", cwd: "/x/proj1", startedAt: 100),
            .init(id: "b", cwd: "/x/proj1", startedAt: 200),
            .init(id: "c", cwd: "/x/proj2", startedAt: 300),
        ]
        let groups = SessionGrouping.groupByDirectory(sessions)
        XCTAssertEqual(groups.count, 2)
        // proj2 first (most-recent activity 300 > 200).
        XCTAssertEqual(groups[0].basename, "proj2")
        XCTAssertEqual(groups[1].basename, "proj1")
        XCTAssertEqual(Set(groups[1].sessions.map { $0.id }), ["a", "b"])
    }

    func testGroupByDirectory_worktreeFoldsToGroupCwd() {
        let sessions: [DashboardSession] = [
            .init(id: "a", cwd: "/x/proj/.worktrees/wt1", groupCwd: "/x/proj"),
            .init(id: "b", cwd: "/x/proj"),
        ]
        let groups = SessionGrouping.groupByDirectory(sessions)
        XCTAssertEqual(groups.count, 1) // both fold under /x/proj
        XCTAssertEqual(groups[0].cwd, "/x/proj")
        XCTAssertEqual(Set(groups[0].sessions.map { $0.id }), ["a", "b"])
    }

    func testGroupByDirectory_pinnedFirstInPinOrderIncludingEmpty() {
        let sessions: [DashboardSession] = [
            .init(id: "a", cwd: "/x/unpinned", startedAt: 500),
            .init(id: "b", cwd: "/x/pinB", startedAt: 100),
        ]
        let groups = SessionGrouping.groupByDirectory(
            sessions, pinnedDirectories: ["/x/pinA", "/x/pinB"])
        // pinA (empty) + pinB come first in pin order, then unpinned.
        XCTAssertEqual(groups.map { $0.cwd }, ["/x/pinA", "/x/pinB", "/x/unpinned"])
        XCTAssertTrue(groups[0].pinned)
        XCTAssertTrue(groups[0].sessions.isEmpty) // empty pinned dir retained
        XCTAssertFalse(groups[2].pinned)
    }

    func testGroupByDirectory_trailingSlashFolding() {
        let sessions: [DashboardSession] = [
            .init(id: "a", cwd: "/x/proj/"),
            .init(id: "b", cwd: "/x/proj"),
        ]
        // Pin written with a trailing slash must still match both sessions.
        let groups = SessionGrouping.groupByDirectory(sessions, pinnedDirectories: ["/x/proj/"])
        XCTAssertEqual(groups.count, 1)
        XCTAssertEqual(groups[0].sessions.count, 2)
        XCTAssertTrue(groups[0].pinned)
    }

    func testGroupByDirectory_honorsServerOrderWithinGroup() {
        let sessions: [DashboardSession] = [
            .init(id: "a", cwd: "/x/p", startedAt: 100),
            .init(id: "b", cwd: "/x/p", startedAt: 200),
            .init(id: "c", cwd: "/x/p", startedAt: 300),
        ]
        let groups = SessionGrouping.groupByDirectory(sessions, orders: ["/x/p": ["c", "a"]])
        // explicit order [c, a] first, then startedAt-desc for the rest (b).
        XCTAssertEqual(groups[0].sessions.map { $0.id }, ["c", "a", "b"])
    }

    func testGroupTierByFolder_offFlattens() {
        let sessions: [DashboardSession] = [
            .init(id: "a", cwd: "/x/p1"),
            .init(id: "b", cwd: "/x/p2"),
        ]
        let flat = SessionGrouping.groupTierByFolder(sessions, folders: false)
        XCTAssertEqual(flat.count, 1)
        XCTAssertEqual(flat[0].sessions.count, 2)
        let nested = SessionGrouping.groupTierByFolder(sessions, folders: true)
        XCTAssertEqual(nested.count, 2)
    }

    func testGroupTierByFolder_emptyYieldsNoGroups() {
        XCTAssertTrue(SessionGrouping.groupTierByFolder([], folders: true).isEmpty)
        XCTAssertTrue(SessionGrouping.groupTierByFolder([], folders: false).isEmpty)
    }

    func testGroupTierByFolder_dropsEmptyPinnedGroups() {
        // A pinned dir with NO sessions in THIS tier must not render as an empty
        // folder (it left a blank gap under every tier header). Pinned dirs that DO
        // have sessions here keep their badge.
        let sessions: [DashboardSession] = [
            .init(id: "a", cwd: "/x/pinned", startedAt: 100),
            .init(id: "b", cwd: "/x/other", startedAt: 200),
        ]
        let groups = SessionGrouping.groupTierByFolder(
            sessions, folders: true, pinnedDirectories: ["/x/pinned", "/x/empty-pin"])
        // /x/empty-pin (zero sessions in this tier) dropped; /x/pinned kept + badged.
        XCTAssertEqual(groups.map { $0.cwd }, ["/x/pinned", "/x/other"])
        XCTAssertTrue(groups[0].pinned)
        XCTAssertFalse(groups.contains { $0.sessions.isEmpty })
    }
}
