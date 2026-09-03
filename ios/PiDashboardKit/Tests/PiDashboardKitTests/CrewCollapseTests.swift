import XCTest
@testable import PiDashboardKit

/// Same-name tenure folding stays scoped to a directory. Repeated tenures in one cwd
/// collapse behind `+N`; same-name sessions in distinct cwds remain distinct rows.
///
/// Also §2 — the collapsed-directory fold state persists via `ListPrefsStore`.
final class CrewCollapseTests: XCTestCase {

    private func session(_ id: String, name: String? = nil, cwd: String? = nil,
                         source: String? = nil,
                         groupCwd: String? = nil,
                         lastActivityAt: Double? = nil, startedAt: Double? = nil) -> DashboardSession {
        DashboardSession(id: id, cwd: cwd, name: name, source: source,
                         startedAt: startedAt, lastActivityAt: lastActivityAt,
                         groupCwd: groupCwd)
    }

    private func group(_ cwd: String, pinned: Bool = false, _ sessions: [DashboardSession])
        -> SessionGrouping.DirectoryGroup {
        SessionGrouping.DirectoryGroup(cwd: cwd, sessions: sessions, pinned: pinned)
    }

    private func rows(_ sessions: [DashboardSession], folders: Bool)
        -> [SessionGrouping.CollapsedSession] {
        let groups = SessionGrouping.groupTierByFolder(sessions, folders: folders)
        return SessionGrouping.collapseGroups(groups).flatMap(\.rows)
    }

    private func renderedGroups(_ sessions: [DashboardSession], folders: Bool)
        -> [SessionGrouping.CollapsedDirectoryGroup] {
        SessionGrouping.groupByTier(sessions).flatMap { _, tierSessions in
            let groups = SessionGrouping.groupTierByFolder(tierSessions, folders: folders)
            return SessionGrouping.collapseGroups(groups)
        }
    }

    // MARK: row-group identity across tier sections

    func testCollapsedGroupIDsAreUniqueAcrossTiersSharingCwd() {
        let groups = renderedGroups([
            session("crew", name: "Peggy", cwd: "/shared"),
            session("other", name: "Atlas-4", cwd: "/shared"),
        ], folders: true)

        XCTAssertEqual(groups.map(\.cwd), ["/shared", "/shared"])
        XCTAssertEqual(Set(groups.map(\.id)).count, groups.count)
    }

    func testCollapsedGroupIDsAreUniqueAcrossThreeFlatTierGroups() {
        let groups = renderedGroups([
            session("crew", name: "Peggy", cwd: "/crew"),
            session("operator", name: "Operator", cwd: "/chat", source: "tui"),
            session("other", name: "Atlas-4", cwd: "/other"),
        ], folders: false)

        XCTAssertEqual(groups.count, 3)
        XCTAssertTrue(groups.allSatisfy { $0.cwd.isEmpty })
        XCTAssertEqual(Set(groups.map(\.id)).count, groups.count)
    }

    func testSameTierSameDirectoryRemainsOneCollapsedGroup() {
        let groups = renderedGroups([
            session("atlas", name: "Atlas-4", cwd: "/shared"),
            session("navigator", name: "NavigatorPopulation-7", cwd: "/shared"),
        ], folders: true)

        XCTAssertEqual(groups.count, 1)
        XCTAssertEqual(Set(groups[0].rows.map { $0.session.id }), ["atlas", "navigator"])
    }

    // MARK: isCrewKey

    func testIsCrewKey() {
        XCTAssertTrue(SessionGrouping.isCrewKey("joan"))
        XCTAssertTrue(SessionGrouping.isCrewKey("pete"))
        XCTAssertTrue(SessionGrouping.isCrewKey("don"))
        // Non-crew canonical keys (full lowercased names / near-misses) are NOT crew.
        XCTAssertFalse(SessionGrouping.isCrewKey("cartographer"))
        XCTAssertFalse(SessionGrouping.isCrewKey("donna"))   // canonicalNameKey("Donna") == "donna"
        XCTAssertFalse(SessionGrouping.isCrewKey("petersen"))
    }

    // MARK: cross-cwd crew stays visible; same-cwd tenures still fold

    func testCrossCwdCrewFoldsWithinEachDirectory() {
        // Pete: 4 tenures under /orch, 1 under /tmp (mirrors the live doubling).
        let groups = [
            group("/orch", [
                session("p1", name: "Pete-tenure-4", lastActivityAt: 400),   // newest → survivor
                session("p2", name: "Pete-tenure-3", lastActivityAt: 300),
                session("p3", name: "Pete-tenure-2", lastActivityAt: 200),
                session("p4", name: "Pete-tenure-1", lastActivityAt: 100),
            ]),
            group("/tmp", [
                session("p5", name: "Pete", lastActivityAt: 50),
            ]),
        ]
        let out = SessionGrouping.collapseGroups(groups)
        XCTAssertEqual(out.count, 2)
        XCTAssertEqual(out[0].cwd, "/orch")
        XCTAssertEqual(out[0].rows.count, 1)
        XCTAssertEqual(out[0].rows[0].session.id, "p1", "most-recent same-cwd tenure survives")
        XCTAssertEqual(out[0].rows[0].olderCount, 3)
        XCTAssertEqual(Set(out[0].rows[0].olderIds), ["p2", "p3", "p4"])
        XCTAssertEqual(out[1].cwd, "/tmp")
        XCTAssertEqual(out[1].rows.map(\.session.id), ["p5"])
        XCTAssertEqual(out[1].rows[0].olderCount, 0)
    }

    // MARK: non-crew is UNAFFECTED (still per-cwd)

    func testNonCrewStaysPerCwd() {
        // Same non-crew name (Cartographer) in two cwds → genuinely two rows.
        let groups = [
            group("/a", [session("c1", name: "Cartographer", lastActivityAt: 100)]),
            group("/b", [session("c2", name: "Cartographer", lastActivityAt: 200)]),
        ]
        let out = SessionGrouping.collapseGroups(groups)
        XCTAssertEqual(out.count, 2, "non-crew name is NOT folded across cwds")
        XCTAssertEqual(out.flatMap { $0.rows }.count, 2)
        XCTAssertTrue(out.allSatisfy { $0.rows.allSatisfy { $0.olderCount == 0 } })
    }

    func testNonCrewFoldsWithinOneCwd() {
        // But a repeated non-crew name in ONE cwd still folds (per-group behavior kept).
        let groups = [
            group("/a", [
                session("c1", name: "Cartographer", lastActivityAt: 100),
                session("c2", name: "Cartographer", lastActivityAt: 300),  // newest
            ]),
        ]
        let out = SessionGrouping.collapseGroups(groups)
        XCTAssertEqual(out.count, 1)
        XCTAssertEqual(out[0].rows.count, 1)
        XCTAssertEqual(out[0].rows[0].session.id, "c2")
        XCTAssertEqual(out[0].rows[0].olderCount, 1)
    }

    // MARK: selected-session promotion never suppresses another directory

    func testSelectedCrewTenureDoesNotSuppressOtherGroups() {
        let groups = [
            group("/orch", [session("p_new", name: "Pete", lastActivityAt: 500)]),
            group("/tmp",  [session("p_old", name: "Pete-tenure-1", lastActivityAt: 100)]),
        ]
        let out = SessionGrouping.collapseGroups(groups, selectedId: "p_old")
        XCTAssertEqual(out.count, 2)
        XCTAssertEqual(out.flatMap(\.rows).map(\.session.id), ["p_new", "p_old"])
        XCTAssertTrue(out.flatMap(\.rows).allSatisfy { $0.olderCount == 0 })
    }

    // MARK: mixed crew + non-crew, first-seen order preserved per directory

    func testMixedGroupKeepsCrossDirectoryCrewAndOrder() {
        let groups = [
            group("/a", [
                session("pa", name: "Pete", lastActivityAt: 100),          // non-home (older)
                session("ja", name: "Joan", lastActivityAt: 100),          // home here
                session("ca", name: "Cartographer", lastActivityAt: 100),  // non-crew
            ]),
            group("/b", [
                session("pb", name: "Pete", lastActivityAt: 500),          // Pete survivor
            ]),
        ]
        let out = SessionGrouping.collapseGroups(groups)
        XCTAssertEqual(out.count, 2)
        let a = out.first { $0.cwd == "/a" }!
        XCTAssertEqual(a.rows.map { $0.session.id }, ["pa", "ja", "ca"])
        XCTAssertTrue(a.rows.allSatisfy { $0.olderCount == 0 })
        let b = out.first { $0.cwd == "/b" }!
        XCTAssertEqual(b.rows.map { $0.session.id }, ["pb"])
        XCTAssertEqual(b.rows[0].olderCount, 0)
        XCTAssertTrue(b.rows[0].olderIds.isEmpty)
    }

    // MARK: same-cwd crew fold still works (regression of the original per-cwd case)

    func testSameCwdCrewStillFolds() {
        let groups = [
            group("/a", [
                session("j1", name: "Joan-tenure-1", lastActivityAt: 100),
                session("j2", name: "Joan-tenure-2", lastActivityAt: 300),  // newest
                session("j3", name: "Joan-tenure-3", lastActivityAt: 200),
            ]),
        ]
        let out = SessionGrouping.collapseGroups(groups)
        XCTAssertEqual(out.count, 1)
        XCTAssertEqual(out[0].rows.count, 1)
        XCTAssertEqual(out[0].rows[0].session.id, "j2")
        XCTAssertEqual(out[0].rows[0].olderCount, 2)
    }

    // MARK: equal-recency crew rows in distinct directories do not compete

    func testCrossCwdCrewRowsDoNotCompeteOnTie() {
        let groups = [
            group("/a", [session("aaa", name: "Pete", lastActivityAt: 100)]),
            group("/b", [session("zzz", name: "Pete", lastActivityAt: 100)]),  // same recency
        ]
        let out = SessionGrouping.collapseGroups(groups)
        XCTAssertEqual(out.count, 2)
        XCTAssertEqual(out.flatMap(\.rows).map(\.session.id), ["aaa", "zzz"])
        XCTAssertTrue(out.flatMap(\.rows).allSatisfy { $0.olderCount == 0 })
    }

    // MARK: folders-OFF flat bucket — crew still folds to one row within the single group

    func testFlatBucketFoldsCrewToOne() {
        // Both Pete sessions have the same nil cwd, so they remain one identity.
        let flat = [group("", [
            session("p1", name: "Pete-1", lastActivityAt: 100),
            session("p2", name: "Pete-2", lastActivityAt: 300),
            session("d1", name: "Don", lastActivityAt: 50),
        ])]
        let out = SessionGrouping.collapseGroups(flat)
        XCTAssertEqual(out.count, 1)
        XCTAssertEqual(out[0].rows.count, 2, "Pete folded to one; Don separate")
        let pete = out[0].rows.first { $0.session.name?.hasPrefix("Pete") == true }!
        XCTAssertEqual(pete.session.id, "p2")
        XCTAssertEqual(pete.olderCount, 1)
    }

    // MARK: folders toggle preserves visible rows

    func testSameNameDifferentCwdsSurviveFoldersOff() {
        let sessions = [
            session("c1", name: "Cartographer", cwd: "/a"),
            session("c2", name: "Cartographer", cwd: "/b"),
        ]

        XCTAssertEqual(rows(sessions, folders: false).count, 2)
    }

    func testSameNameThreeCwdsSurviveFoldersOff() {
        let sessions = [
            session("c1", name: "Cartographer", cwd: "/a"),
            session("c2", name: "Cartographer", cwd: "/b"),
            session("c3", name: "Cartographer", cwd: "/c"),
        ]

        XCTAssertEqual(rows(sessions, folders: false).count, 3)
    }

    func testFoldersToggleDoesNotChangeRowCount() {
        let fixtures: [(name: String, sessions: [DashboardSession], expectedRows: Int)] = [
            ("same name, different cwds", [
                session("a1", name: "Cartographer", cwd: "/a"),
                session("a2", name: "Cartographer", cwd: "/b"),
            ], 2),
            ("distinct names", [
                session("b1", name: "Cartographer", cwd: "/a"),
                session("b2", name: "Navigator", cwd: "/b"),
            ], 2),
            ("crew name, different cwds", [
                session("c1", name: "Pete", cwd: "/a"),
                session("c2", name: "Pete-tenure-1", cwd: "/b"),
            ], 2),
            ("same name, same cwd", [
                session("d1", name: "Cartographer", cwd: "/same"),
                session("d2", name: "Cartographer", cwd: "/same"),
            ], 1),
            ("same name, three cwds", [
                session("e1", name: "Cartographer", cwd: "/a"),
                session("e2", name: "Cartographer", cwd: "/b"),
                session("e3", name: "Cartographer", cwd: "/c"),
            ], 3),
        ]

        for fixture in fixtures {
            let foldersOn = rows(fixture.sessions, folders: true).count
            let foldersOff = rows(fixture.sessions, folders: false).count
            XCTAssertEqual(foldersOn, foldersOff, fixture.name)
            XCTAssertEqual(foldersOn, fixture.expectedRows, fixture.name)
        }
    }

    func testWorktreeSessionsUseGroupPathIdentity() {
        let repoA = [
            session("a1", name: "Cartographer", cwd: "/repo-a/.worktrees/one",
                    groupCwd: "/repo-a", lastActivityAt: 100),
            session("a2", name: "Cartographer", cwd: "/repo-a/.worktrees/two",
                    groupCwd: "/repo-a", lastActivityAt: 200),
        ]

        for folders in [true, false] {
            let visible = rows(repoA, folders: folders)
            XCTAssertEqual(visible.count, 1, "same groupCwd must fold with folders=\(folders)")
            XCTAssertEqual(visible[0].olderCount, 1)
        }

        let acrossRepos = repoA + [
            session("b1", name: "Cartographer", cwd: "/repo-b/.worktrees/one",
                    groupCwd: "/repo-b", lastActivityAt: 300),
            session("b2", name: "Cartographer", cwd: "/repo-b/.worktrees/two",
                    groupCwd: "/repo-b", lastActivityAt: 400),
        ]

        for folders in [true, false] {
            let visible = rows(acrossRepos, folders: folders)
            XCTAssertEqual(visible.count, 2, "different groupCwds must survive with folders=\(folders)")
            XCTAssertEqual(visible.map(\.olderCount).sorted(), [1, 1])
        }
    }

    func testDistinctNamesUnaffectedByFoldersToggle() {
        let sessions = [
            session("c", name: "Cartographer", cwd: "/a"),
            session("n", name: "Navigator", cwd: "/b"),
        ]

        for folders in [true, false] {
            XCTAssertEqual(rows(sessions, folders: folders).count, 2)
        }
    }

    func testSameNameSameCwdStillFolds() {
        let sessions = [
            session("old", name: "Cartographer", cwd: "/same", lastActivityAt: 100),
            session("new", name: "Cartographer", cwd: "/same", lastActivityAt: 200),
        ]

        for folders in [true, false] {
            let visible = rows(sessions, folders: folders)
            XCTAssertEqual(visible.count, 1)
            XCTAssertEqual(visible[0].session.id, "new")
            XCTAssertEqual(visible[0].olderCount, 1)
        }
    }

    func testCrewNamesDoNotFoldAcrossCwds() {
        let sessions = [
            session("old", name: "Pete-tenure-1", cwd: "/a", lastActivityAt: 100),
            session("new", name: "Pete-tenure-2", cwd: "/b", lastActivityAt: 200),
        ]

        for folders in [true, false] {
            let visible = rows(sessions, folders: folders)
            XCTAssertEqual(visible.count, 2)
            XCTAssertEqual(Set(visible.map(\.session.id)), ["old", "new"])
            XCTAssertTrue(visible.allSatisfy { $0.olderCount == 0 })
        }
    }

    // MARK: empty input

    func testEmptyGroupsYieldNothing() {
        XCTAssertTrue(SessionGrouping.collapseGroups([]).isEmpty)
        XCTAssertTrue(SessionGrouping.collapseGroups([group("/a", [])]).isEmpty)
    }

    // MARK: §2 — collapsed-directory fold-state persistence (ephemeral UserDefaults)

    private func ephemeral() -> (UserDefaults, String) {
        let suite = "pi.dashboard.collapsedirs.tests.\(UUID().uuidString)"
        return (UserDefaults(suiteName: suite)!, suite)
    }

    func testCollapsedDirsDefaultsEmpty() {
        let (d, suite) = ephemeral()
        defer { d.removePersistentDomain(forName: suite) }
        XCTAssertTrue(ListPrefsStore.loadCollapsedDirs(from: d).isEmpty, "every folder expanded by default")
    }

    func testCollapsedDirsRoundTrips() {
        let (d, suite) = ephemeral()
        defer { d.removePersistentDomain(forName: suite) }
        let dirs: Set<String> = ["/x/proj", "/y/other"]
        ListPrefsStore.saveCollapsedDirs(dirs, to: d)
        XCTAssertEqual(ListPrefsStore.loadCollapsedDirs(from: d), dirs, "collapsed set survives a relaunch")
        // Emptying clears the key → resolves back to the all-expanded default.
        ListPrefsStore.saveCollapsedDirs([], to: d)
        XCTAssertTrue(ListPrefsStore.loadCollapsedDirs(from: d).isEmpty)
    }
}
