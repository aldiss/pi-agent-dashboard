import XCTest
@testable import PiDashboardKit

/// DF#2 — session-list declutter: hide ended by default + collapse repeated
/// same-name crew tenures to the most-recent with a `+N` count. Pure logic verified
/// via `swift test`, no simulator. (419 sessions → ~49 non-ended, crew folded to one
/// row each.)
final class SessionDeclutterTests: XCTestCase {

    private func session(_ id: String, name: String? = nil, status: String? = nil,
                         lastActivityAt: Double? = nil, startedAt: Double? = nil) -> DashboardSession {
        DashboardSession(id: id, name: name, status: status,
                         startedAt: startedAt, lastActivityAt: lastActivityAt)
    }

    // MARK: filterEnded (hide ended by default)

    func testFilterEndedHidesEndedByDefault() {
        let sessions = [
            session("a", status: "active"),
            session("b", status: "ended"),
            session("c", status: "idle"),
            session("d", status: "ended"),
        ]
        let shown = SessionGrouping.filterEnded(sessions, hideEnded: true)
        XCTAssertEqual(shown.map(\.id), ["a", "c"], "ended dropped by default")
    }

    func testFilterEndedOffShowsEverything() {
        let sessions = [session("a", status: "active"), session("b", status: "ended")]
        XCTAssertEqual(SessionGrouping.filterEnded(sessions, hideEnded: false).count, 2)
    }

    /// The currently-viewed session is preserved even when ended (open chat mustn't
    /// vanish out from under the operator).
    func testFilterEndedKeepsSelectedEvenIfEnded() {
        let sessions = [session("a", status: "ended"), session("b", status: "ended")]
        let shown = SessionGrouping.filterEnded(sessions, hideEnded: true, selectedId: "b")
        XCTAssertEqual(shown.map(\.id), ["b"], "selected ended session stays visible")
    }

    // MARK: canonicalNameKey (crew tenure folding)

    func testCanonicalNameKeyFoldsCrewTenures() {
        XCTAssertEqual(SessionGrouping.canonicalNameKey(session("1", name: "Joan-tenure-23")), "joan")
        XCTAssertEqual(SessionGrouping.canonicalNameKey(session("2", name: "Joan — Joan tenure-4 · shipping")), "joan")
        XCTAssertEqual(SessionGrouping.canonicalNameKey(session("3", name: "Faye")), "faye")
        XCTAssertEqual(SessionGrouping.canonicalNameKey(session("4", name: "don")), "don")
    }

    /// A longer word that merely STARTS with a crew name must NOT fold (`Donna` ≠
    /// `Don`, `Petersen` ≠ `Pete`) — the anchored non-letter boundary.
    func testCanonicalNameKeyDoesNotOverfold() {
        XCTAssertEqual(SessionGrouping.canonicalNameKey(session("1", name: "Donna")), "donna")
        XCTAssertEqual(SessionGrouping.canonicalNameKey(session("2", name: "Petersen")), "petersen")
        XCTAssertNotEqual(SessionGrouping.canonicalNameKey(session("3", name: "Donna")),
                          SessionGrouping.canonicalNameKey(session("4", name: "Don-tenure-1")))
    }

    /// Non-crew names fold by exact (case-insensitive) name; empty name → id (never
    /// collapses distinct anonymous sessions together).
    func testCanonicalNameKeyNonCrewAndEmpty() {
        XCTAssertEqual(SessionGrouping.canonicalNameKey(session("1", name: "Cartographer")), "cartographer")
        XCTAssertEqual(SessionGrouping.canonicalNameKey(session("x", name: nil)), "x")
        XCTAssertEqual(SessionGrouping.canonicalNameKey(session("y", name: "   ")), "y")
    }

    // MARK: collapseSameName (most-recent wins + count)

    func testCollapseKeepsMostRecentWithCount() {
        let sessions = [
            session("j1", name: "Joan-tenure-1", lastActivityAt: 100),
            session("j2", name: "Joan-tenure-2", lastActivityAt: 300), // newest
            session("j3", name: "Joan-tenure-3", lastActivityAt: 200),
        ]
        let collapsed = SessionGrouping.collapseSameName(sessions)
        XCTAssertEqual(collapsed.count, 1, "three Joan tenures fold to one row")
        XCTAssertEqual(collapsed[0].session.id, "j2", "most-recent by lastActivityAt wins")
        XCTAssertEqual(collapsed[0].olderCount, 2, "+2 older tenures")
        XCTAssertEqual(Set(collapsed[0].olderIds), ["j1", "j3"])
    }

    /// Recency falls back to startedAt when lastActivityAt is absent.
    func testCollapseUsesStartedAtFallback() {
        let sessions = [
            session("a", name: "Faye", startedAt: 50),
            session("b", name: "Faye", startedAt: 90),  // newest by startedAt
        ]
        let collapsed = SessionGrouping.collapseSameName(sessions)
        XCTAssertEqual(collapsed[0].session.id, "b")
        XCTAssertEqual(collapsed[0].olderCount, 1)
    }

    /// Distinct names are NOT collapsed; single-session names carry olderCount 0.
    func testCollapseLeavesDistinctNamesAlone() {
        let sessions = [
            session("a", name: "Joan", lastActivityAt: 10),
            session("b", name: "Peggy", lastActivityAt: 20),
            session("c", name: "Faye", lastActivityAt: 30),
        ]
        let collapsed = SessionGrouping.collapseSameName(sessions)
        XCTAssertEqual(collapsed.count, 3)
        XCTAssertTrue(collapsed.allSatisfy { $0.olderCount == 0 })
    }

    /// Deterministic tie-break: equal recency → higher id wins (stable across runs).
    func testCollapseDeterministicTieBreak() {
        let sessions = [
            session("aaa", name: "Don", lastActivityAt: 100),
            session("zzz", name: "Don", lastActivityAt: 100), // same recency
        ]
        let collapsed = SessionGrouping.collapseSameName(sessions)
        XCTAssertEqual(collapsed[0].session.id, "zzz", "id-desc tie-break")
        XCTAssertEqual(collapsed[0].olderCount, 1)
    }

    /// The selected session becomes the surviving row for its name even when it's an
    /// OLDER tenure (so an open ended chat stays put).
    func testCollapsePromotesSelected() {
        let sessions = [
            session("new", name: "Lane", lastActivityAt: 500),
            session("old", name: "Lane", lastActivityAt: 100),
        ]
        let collapsed = SessionGrouping.collapseSameName(sessions, selectedId: "old")
        XCTAssertEqual(collapsed[0].session.id, "old", "selected older tenure promoted")
        XCTAssertEqual(collapsed[0].olderCount, 1)
        XCTAssertEqual(collapsed[0].olderIds, ["new"])
    }

    /// First-seen order of surviving rows is preserved (respects prior server sort).
    func testCollapsePreservesFirstSeenOrder() {
        let sessions = [
            session("p", name: "Peggy", lastActivityAt: 1),
            session("j", name: "Joan", lastActivityAt: 1),
            session("p2", name: "Peggy", lastActivityAt: 2),
        ]
        let collapsed = SessionGrouping.collapseSameName(sessions)
        XCTAssertEqual(collapsed.map { $0.session.name?.lowercased() }, ["peggy", "joan"],
                       "Peggy seen first stays first; its newer tenure p2 is the survivor")
        XCTAssertEqual(collapsed[0].session.id, "p2")
    }

    // MARK: hide-ended persistence (ephemeral UserDefaults)

    private func ephemeral() -> (UserDefaults, String) {
        let suite = "pi.dashboard.listprefs.tests.\(UUID().uuidString)"
        return (UserDefaults(suiteName: suite)!, suite)
    }

    func testHideEndedDefaultsTrueOnFreshInstall() {
        let (d, suite) = ephemeral()
        defer { d.removePersistentDomain(forName: suite) }
        XCTAssertTrue(ListPrefsStore.loadHideEnded(from: d), "ended hidden by default")
    }

    func testHideEndedRoundTrips() {
        let (d, suite) = ephemeral()
        defer { d.removePersistentDomain(forName: suite) }
        ListPrefsStore.saveHideEnded(false, to: d)
        XCTAssertFalse(ListPrefsStore.loadHideEnded(from: d), "operator revealed ended")
        // Saving the default (true) clears the key → resolves back to default.
        ListPrefsStore.saveHideEnded(true, to: d)
        XCTAssertTrue(ListPrefsStore.loadHideEnded(from: d))
    }
}
