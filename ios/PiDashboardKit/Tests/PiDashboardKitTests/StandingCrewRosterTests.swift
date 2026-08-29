import XCTest
@testable import PiDashboardKit

/// The standing-crew roster is ten names. Harry and Dawn were absent from the
/// native regex while the web client carried all ten, so their live sessions
/// classified as `.other` — a tier that is collapsed by default, which made two
/// crew members invisible in the app but present in the browser.
final class StandingCrewRosterTests: XCTestCase {
    private func session(named name: String) -> DashboardSession {
        let json = #"{"id":"x","name":"\#(name)","cwd":"/w","source":"tmux","status":"idle"}"#
        return try! JSONDecoder().decode(DashboardSession.self, from: Data(json.utf8))
    }

    func testEveryStandingCrewNameClassifiesAsStandingCrew() {
        for name in ["Bert", "Joan", "Peggy", "Lane", "Pete", "Faye", "Don", "Alice", "Harry", "Dawn"] {
            XCTAssertEqual(SessionGrouping.classifyTier(session(named: name)), .standingCrew,
                           "\(name) must classify as standing-crew")
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
}
