import XCTest
@testable import PiDashboardKit

/// Unit tests for the session grouping/filter logic — the sidebar's tier + folder
/// semantics. Grounded in the real crew/driver names + cwd shapes from the live
/// dashboard so the native app inherits the dashboard's ACTUAL grouping behavior.
final class GroupingTests: XCTestCase {

    func testClassifyTier_standingCrewBeatsSource() {
        // "Joan" on a tui session → standing-crew (crew rule precedes the tui rule).
        XCTAssertEqual(SessionGrouping.classifyTier(.init(id: "1", cwd: "/x", name: "Joan", source: "tui")), .standingCrew)
        // "Don — Don tenure-4 …" (em-dash boundary after Don) → standing-crew.
        XCTAssertEqual(SessionGrouping.classifyTier(.init(id: "2", cwd: "/x", name: "Don — Don tenure-4", source: "tmux")), .standingCrew)
    }

    func testClassifyTier_crewBoundaryRejectsLongerWord() {
        // "Donna" / "NotJoan" must NOT match the crew rule (start-anchored + boundary).
        XCTAssertNotEqual(SessionGrouping.classifyTier(.init(id: "3", name: "Donna", source: "tmux")), .standingCrew)
        XCTAssertNotEqual(SessionGrouping.classifyTier(.init(id: "4", name: "NotJoan", source: "tmux")), .standingCrew)
    }

    func testClassifyTier_driverByCwd() {
        // tmux + cwd under nos-cells/ → drivers (real: Cartographer @ nos-cells/arch-diagram-driver).
        XCTAssertEqual(SessionGrouping.classifyTier(.init(id: "5", cwd: "/Users/x/nos-cells/arch-diagram-driver", name: "Cartographer", source: "tmux")), .drivers)
        // "-driver" cell-id outside /.pi/cells/ → drivers.
        XCTAssertEqual(SessionGrouping.classifyTier(.init(id: "6", cwd: "/Users/x/foo-driver", name: "Vault", source: "tmux")), .drivers)
    }

    func testClassifyTier_operatorChatPaneAndOther() {
        XCTAssertEqual(SessionGrouping.classifyTier(.init(id: "7", cwd: "/x", name: "random", source: "tui")), .operatorChatPane)
        XCTAssertEqual(SessionGrouping.classifyTier(.init(id: "8", cwd: "/Users/vdrobkov", name: "Scratch", source: "tmux")), .other)
    }

    func testClassifyTier_workers() {
        XCTAssertEqual(SessionGrouping.classifyTier(.init(id: "9", name: "subagent-worker-3f4a9c")), .worker)
        XCTAssertEqual(SessionGrouping.classifyTier(.init(id: "10", source: "tmux", sessionFile: "/a/run-2/session.jsonl")), .worker)
    }

    func testClassifyTier_cellExecutor() {
        // themed compound PascalCase + tmux + inside /.pi/cells/ → cell-executor.
        XCTAssertEqual(SessionGrouping.classifyTier(.init(id: "11", cwd: "/a/.pi/cells/foo", name: "UltraMoon", source: "tmux")), .cellExecutor)
        // explicit "cell-executor" substring in name.
        XCTAssertEqual(SessionGrouping.classifyTier(.init(id: "12", cwd: "/a", name: "foo cell-executor", source: "tmux")), .cellExecutor)
    }

    func testGroupByTier_ordersAndOmitsEmpty() {
        let sessions: [DashboardSession] = [
            .init(id: "a", cwd: "/Users/x", name: "Scratch", source: "tmux"),   // other
            .init(id: "b", cwd: "/x", name: "Joan", source: "tui"),             // standing-crew
            .init(id: "c", cwd: "/x/nos-cells/y-driver", name: "Keystone", source: "tmux"), // drivers
        ]
        let groups = SessionGrouping.groupByTier(sessions)
        XCTAssertEqual(groups.map { $0.tier }, [.standingCrew, .drivers, .other])
    }

    func testFilterByQuery_nameThenFirstMessageThenBasename() {
        let sessions: [DashboardSession] = [
            .init(id: "1", name: "Joan"),
            .init(id: "2", name: "Cartographer"),
            .init(id: "3", cwd: "/a/pi-shodh", name: nil, firstMessage: nil),
        ]
        XCTAssertEqual(SessionGrouping.filterByQuery(sessions, "cart").map { $0.id }, ["2"])
        XCTAssertEqual(SessionGrouping.filterByQuery(sessions, "pi-sho").map { $0.id }, ["3"]) // cwd basename fallback
        XCTAssertEqual(SessionGrouping.filterByQuery(sessions, "  ").count, 3)                  // blank → passthrough
    }

    func testFilterStale_dropsStaleActiveKeepsEnded() {
        let now = 1_000_000_000_000.0
        let fresh: DashboardSession = .init(id: "f", status: "active", startedAt: now)
        let stale: DashboardSession = .init(id: "s", status: "active", startedAt: now - 10 * 3600 * 1000)
        let ended: DashboardSession = .init(id: "e", status: "ended", startedAt: now - 999 * 3600 * 1000)
        let out = SessionGrouping.filterStale([fresh, stale, ended], staleHoursThreshold: 5, hideStale: true, now: now)
        XCTAssertEqual(Set(out.map { $0.id }), ["f", "e"])
        // selected stale session is preserved.
        let out2 = SessionGrouping.filterStale([stale], staleHoursThreshold: 5, hideStale: true, now: now, selectedId: "s")
        XCTAssertEqual(out2.map { $0.id }, ["s"])
        // disabled → passthrough.
        XCTAssertEqual(SessionGrouping.filterStale([stale], staleHoursThreshold: 5, hideStale: false, now: now).count, 1)
    }

    func testFilterSessionsActiveOnlyMatchesWebEndedSemantics() {
        var endedByTimestamp = DashboardSession(id: "ended-at", status: "idle")
        endedByTimestamp.endedAt = 123
        let sessions: [DashboardSession] = [
            .init(id: "active", status: "active"),
            .init(id: "ended-status", status: "ended"),
            endedByTimestamp,
        ]

        let active = SessionGrouping.filterSessions(
            sessions, activeOnly: true, showHidden: true)
        XCTAssertEqual(active.map(\.id), ["active"], "status or endedAt excludes an ended session")

        let flagOff = SessionGrouping.filterSessions(
            sessions, activeOnly: false, showHidden: true)
        XCTAssertEqual(flagOff, sessions, "default-off behavior remains today's unfiltered set")
    }

    func testRankActiveFirst_stable() {
        let sessions: [DashboardSession] = [
            .init(id: "e1", status: "ended"),
            .init(id: "a1", status: "active"),
            .init(id: "e2", status: "ended"),
            .init(id: "a2", status: "active"),
        ]
        XCTAssertEqual(SessionGrouping.rankActiveFirst(sessions).map { $0.id }, ["a1", "a2", "e1", "e2"])
    }

    func testSortSessionsByOrder() {
        let sessions: [DashboardSession] = [
            .init(id: "x", startedAt: 100),
            .init(id: "y", startedAt: 300),
            .init(id: "z", startedAt: 200),
        ]
        // explicit order first, then startedAt-desc for the rest.
        XCTAssertEqual(SessionGrouping.sortSessionsByOrder(sessions, order: ["z"]).map { $0.id }, ["z", "y", "x"])
        // no order → startedAt desc.
        XCTAssertEqual(SessionGrouping.sortSessionsByOrder(sessions, order: nil).map { $0.id }, ["y", "z", "x"])
    }
}
