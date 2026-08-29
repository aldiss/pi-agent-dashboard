import XCTest
@testable import PiDashboardKit

/// Usability round 2 §3 — crew sessions were STILL doubling in the list. Root cause:
/// `collapseSameName` folds PER directory-group, so a standing-crew canonical name
/// with tenures in >1 cwd rendered once per cwd-group (the operator saw Pete twice —
/// `nos-cells` + `unend-e2e-cwd`). `collapseGroupsFoldingCrew` folds crew names
/// GLOBALLY across a tier's groups (one survivor in its most-recent cwd, `+N` counts
/// ALL tenures) while non-crew names keep per-cwd folding. Pure — verified here.
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
        return SessionGrouping.collapseGroupsFoldingCrew(groups).flatMap(\.rows)
    }

    private func renderedGroups(_ sessions: [DashboardSession], folders: Bool)
        -> [SessionGrouping.CollapsedDirectoryGroup] {
        SessionGrouping.groupByTier(sessions).flatMap { _, tierSessions in
            let groups = SessionGrouping.groupTierByFolder(tierSessions, folders: folders)
            return SessionGrouping.collapseGroupsFoldingCrew(groups)
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

    // MARK: cross-cwd crew → ONE row, +N counts all tenures (the actual bug)

    func testCrossCwdCrewFoldsToOneRow() {
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
        let out = SessionGrouping.collapseGroupsFoldingCrew(groups)
        // Exactly ONE group survives (the survivor's home /orch); /tmp emptied → dropped.
        XCTAssertEqual(out.count, 1)
        XCTAssertEqual(out[0].cwd, "/orch")
        XCTAssertEqual(out[0].rows.count, 1, "Pete folds to a single row across both cwds")
        XCTAssertEqual(out[0].rows[0].session.id, "p1", "most-recent tenure survives")
        XCTAssertEqual(out[0].rows[0].olderCount, 4, "+4 counts ALL other tenures, both cwds")
        XCTAssertEqual(Set(out[0].rows[0].olderIds), ["p2", "p3", "p4", "p5"])
    }

    // MARK: non-crew is UNAFFECTED (still per-cwd)

    func testNonCrewStaysPerCwd() {
        // Same non-crew name (Cartographer) in two cwds → genuinely two rows.
        let groups = [
            group("/a", [session("c1", name: "Cartographer", lastActivityAt: 100)]),
            group("/b", [session("c2", name: "Cartographer", lastActivityAt: 200)]),
        ]
        let out = SessionGrouping.collapseGroupsFoldingCrew(groups)
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
        let out = SessionGrouping.collapseGroupsFoldingCrew(groups)
        XCTAssertEqual(out.count, 1)
        XCTAssertEqual(out[0].rows.count, 1)
        XCTAssertEqual(out[0].rows[0].session.id, "c2")
        XCTAssertEqual(out[0].rows[0].olderCount, 1)
    }

    // MARK: selected-session promotion across groups

    func testSelectedCrewTenurePromotedAcrossGroups() {
        // The open chat is an OLDER Pete tenure in a DIFFERENT cwd than the newest —
        // it must become the survivor (and land in ITS group), not hide behind newest.
        let groups = [
            group("/orch", [session("p_new", name: "Pete", lastActivityAt: 500)]),
            group("/tmp",  [session("p_old", name: "Pete-tenure-1", lastActivityAt: 100)]),
        ]
        let out = SessionGrouping.collapseGroupsFoldingCrew(groups, selectedId: "p_old")
        XCTAssertEqual(out.count, 1)
        XCTAssertEqual(out[0].cwd, "/tmp", "survivor lands in the SELECTED tenure's group")
        XCTAssertEqual(out[0].rows[0].session.id, "p_old")
        XCTAssertEqual(out[0].rows[0].olderCount, 1)
        XCTAssertEqual(out[0].rows[0].olderIds, ["p_new"])
    }

    // MARK: mixed crew + non-crew, first-seen order preserved, non-home crew suppressed

    func testMixedGroupSuppressesNonHomeCrewKeepsOrder() {
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
        let out = SessionGrouping.collapseGroupsFoldingCrew(groups)
        XCTAssertEqual(out.count, 2)
        let a = out.first { $0.cwd == "/a" }!
        // Pete is suppressed in /a (non-home); Joan + Cartographer remain in first-seen order.
        XCTAssertEqual(a.rows.map { $0.session.id }, ["ja", "ca"])
        XCTAssertFalse(a.rows.contains { $0.session.name == "Pete" })
        let b = out.first { $0.cwd == "/b" }!
        XCTAssertEqual(b.rows.map { $0.session.id }, ["pb"])
        XCTAssertEqual(b.rows[0].olderCount, 1, "Pete +1 (the suppressed /a tenure)")
        XCTAssertEqual(b.rows[0].olderIds, ["pa"])
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
        let out = SessionGrouping.collapseGroupsFoldingCrew(groups)
        XCTAssertEqual(out.count, 1)
        XCTAssertEqual(out[0].rows.count, 1)
        XCTAssertEqual(out[0].rows[0].session.id, "j2")
        XCTAssertEqual(out[0].rows[0].olderCount, 2)
    }

    // MARK: deterministic tie-break across groups (equal recency → id-desc)

    func testCrossCwdTieBreakIsDeterministic() {
        let groups = [
            group("/a", [session("aaa", name: "Pete", lastActivityAt: 100)]),
            group("/b", [session("zzz", name: "Pete", lastActivityAt: 100)]),  // same recency
        ]
        let out = SessionGrouping.collapseGroupsFoldingCrew(groups)
        XCTAssertEqual(out.count, 1)
        XCTAssertEqual(out[0].cwd, "/b", "id-desc tie-break → zzz wins, home = /b")
        XCTAssertEqual(out[0].rows[0].session.id, "zzz")
        XCTAssertEqual(out[0].rows[0].olderCount, 1)
    }

    // MARK: folders-OFF flat bucket — crew still folds to one row within the single group

    func testFlatBucketFoldsCrewToOne() {
        // With Folders off the tier is one cwd:"" group; crew must still fold globally.
        let flat = [group("", [
            session("p1", name: "Pete-1", lastActivityAt: 100),
            session("p2", name: "Pete-2", lastActivityAt: 300),
            session("d1", name: "Don", lastActivityAt: 50),
        ])]
        let out = SessionGrouping.collapseGroupsFoldingCrew(flat)
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
        let fixtures: [(name: String, sessions: [DashboardSession])] = [
            ("same name, different cwds", [
                session("a1", name: "Cartographer", cwd: "/a"),
                session("a2", name: "Cartographer", cwd: "/b"),
            ]),
            ("distinct names", [
                session("b1", name: "Cartographer", cwd: "/a"),
                session("b2", name: "Navigator", cwd: "/b"),
            ]),
            ("crew name, different cwds", [
                session("c1", name: "Pete", cwd: "/a"),
                session("c2", name: "Pete-tenure-1", cwd: "/b"),
            ]),
            ("same name, same cwd", [
                session("d1", name: "Cartographer", cwd: "/same"),
                session("d2", name: "Cartographer", cwd: "/same"),
            ]),
            ("same name, three cwds", [
                session("e1", name: "Cartographer", cwd: "/a"),
                session("e2", name: "Cartographer", cwd: "/b"),
                session("e3", name: "Cartographer", cwd: "/c"),
            ]),
        ]

        for fixture in fixtures {
            let foldersOn = rows(fixture.sessions, folders: true).count
            let foldersOff = rows(fixture.sessions, folders: false).count
            XCTAssertEqual(foldersOn, foldersOff, fixture.name)
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

    func testCrewNamesStillFoldGloballyAcrossCwds() {
        let sessions = [
            session("old", name: "Pete-tenure-1", cwd: "/a", lastActivityAt: 100),
            session("new", name: "Pete-tenure-2", cwd: "/b", lastActivityAt: 200),
        ]

        for folders in [true, false] {
            let visible = rows(sessions, folders: folders)
            XCTAssertEqual(visible.count, 1)
            XCTAssertEqual(visible[0].session.id, "new")
            XCTAssertEqual(visible[0].olderCount, 1)
        }
    }

    // MARK: empty input

    func testEmptyGroupsYieldNothing() {
        XCTAssertTrue(SessionGrouping.collapseGroupsFoldingCrew([]).isEmpty)
        XCTAssertTrue(SessionGrouping.collapseGroupsFoldingCrew([group("/a", [])]).isEmpty)
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
