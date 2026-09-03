import XCTest
@testable import PiDashboardKit

/// The standing-crew roster is ten names. Harry and Dawn were absent from the
/// native regex while the web client carried all ten, so their live sessions
/// classified as `.other` — a tier that is collapsed by default, which made two
/// crew members invisible in the app but present in the browser.
final class StandingCrewRosterTests: XCTestCase {
    private let expectedRoster = [
        "Bert", "Joan", "Peggy", "Lane", "Pete", "Faye", "Don", "Alice", "Harry", "Dawn",
    ]

    private func session(_ id: String = "x", named name: String) -> DashboardSession {
        let json = #"{"id":"\#(id)","name":"\#(name)","cwd":"/w","source":"tmux","status":"idle"}"#
        return try! JSONDecoder().decode(DashboardSession.self, from: Data(json.utf8))
    }

    func testEveryStandingCrewNameClassifiesAsStandingCrew() {
        XCTAssertEqual(SessionGrouping.standingCrewNames, expectedRoster,
                       "single roster retains all ten contract names")
        for name in expectedRoster {
            XCTAssertEqual(SessionGrouping.classifyTier(session(named: name)), .standingCrew,
                           "\(name) must classify as standing-crew")
        }
    }

    func testClassificationAndFoldingAgreeForEveryStandingCrewName() {
        for name in SessionGrouping.standingCrewNames {
            let first = session("\(name)-1", named: "\(name)-tenure-1")
            let second = session("\(name)-2", named: "\(name)-tenure-2")

            XCTAssertEqual(SessionGrouping.classifyTier(first), .standingCrew,
                           "\(name) tenure must classify as standing-crew")
            XCTAssertEqual(SessionGrouping.canonicalNameKey(first), name.lowercased(),
                           "\(name) tenure must normalize to the roster key")
            XCTAssertEqual(SessionGrouping.canonicalNameKey(second), name.lowercased(),
                           "\(name) tenures must share one fold key")

            let group = SessionGrouping.DirectoryGroup(
                cwd: "/w", sessions: [first, second], pinned: false)
            let rows = SessionGrouping.collapseGroups([group]).flatMap(\.rows)
            XCTAssertEqual(rows.count, 1, "\(name) tenures in one cwd must fold")
            XCTAssertEqual(rows.first?.olderCount, 1)
        }
    }

    /// Control: the rule is a roster, not "any capitalised word". Without this a
    /// regex broadened to match everything would pass the test above.
    func testNonCrewNamesDoNotClassifyAsStandingCrew() {
        for name in ["Atlas-4", "Briefer", "Curator", "Hearth-19", "Harrison", "Dawnbreaker"] {
            XCTAssertNotEqual(SessionGrouping.classifyTier(session(named: name)), .standingCrew,
                              "\(name) must NOT classify as standing-crew")
        }
    }

    func testCrewPrefixesRemainNonCrewForClassificationAndFolding() {
        for name in ["Harrison", "Dawnbreaker"] {
            let first = session("\(name)-1", named: "\(name)-tenure-1")
            let second = session("\(name)-2", named: "\(name)-tenure-2")

            XCTAssertNotEqual(SessionGrouping.classifyTier(first), .standingCrew)
            XCTAssertEqual(SessionGrouping.canonicalNameKey(first), "\(name.lowercased())-tenure-1")
            let group = SessionGrouping.DirectoryGroup(
                cwd: "/w", sessions: [first, second], pinned: false)
            XCTAssertEqual(SessionGrouping.collapseGroups([group]).flatMap(\.rows).count, 2,
                           "\(name) must not collapse as a crew-prefix match")
        }
    }
}
