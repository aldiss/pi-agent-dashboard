import XCTest
@testable import PiDashboardKit

/// Guards the hermetic e2e fixture CONTRACT (`UITestFixtures`) — the shared source of
/// truth both the app and the qa-e2e XCUITests build against. These assert the fixture
/// SET actually satisfies all 10 UITest scenarios, so a drift here (a renamed id, a
/// dropped tier, Pete no longer folding) fails `swift test` BEFORE it silently breaks
/// the e2e run on CI. The qa-e2e side imports the same constants; keep them stable.
final class UITestFixturesTests: XCTestCase {

    private var sessions: [DashboardSession] { UITestFixtures.sessions }
    private func byId(_ id: String) -> DashboardSession? { sessions.first { $0.id == id } }

    // MARK: identity + stability

    func testLaunchArgIsStable() {
        XCTAssertEqual(UITestFixtures.launchArg, "-uitest-fixtures")
    }

    func testAllIdsUniqueAndStable() {
        let ids = sessions.map(\.id)
        XCTAssertEqual(Set(ids).count, ids.count, "fixture ids must be unique")
        // The exact ids the qa-e2e tests assert against — pin them here.
        for id in [UITestFixtures.peteId, UITestFixtures.peteSecondId, UITestFixtures.cartographerId,
                   UITestFixtures.keystoneId, UITestFixtures.longStatusId, UITestFixtures.endedId,
                   UITestFixtures.voyageId] {
            XCTAssertNotNil(byId(id), "fixture \(id) must be present")
        }
    }

    func testDeterministicNoWallClock() {
        // baseTime is a fixed constant (not Date.now) → the set is identical across runs.
        XCTAssertEqual(UITestFixtures.baseTime, 1_780_272_000_000)
        XCTAssertEqual(UITestFixtures.sessions.map(\.id), UITestFixtures.sessions.map(\.id))
    }

    // MARK: CrewCollapse — Pete in TWO cwds → ONE standing-crew row +1

    func testPeteHasTwoTenuresInTwoDistinctCwds() {
        let petes = sessions.filter { SessionGrouping.canonicalNameKey($0) == "pete" }
        XCTAssertEqual(petes.count, 2, "two Pete tenures")
        XCTAssertEqual(Set(petes.map { $0.cwd ?? "" }).count, 2, "in TWO distinct cwds")
    }

    func testPeteClassifiesAsStandingCrew() {
        XCTAssertEqual(SessionGrouping.classifyTier(byId(UITestFixtures.peteId)!), .standingCrew)
        XCTAssertEqual(SessionGrouping.classifyTier(byId(UITestFixtures.peteSecondId)!), .standingCrew)
    }

    /// The end-to-end collapse the CrewCollapse UITest asserts: run the app's real
    /// pipeline (tier → folder groups → global crew fold) and confirm Pete folds to ONE
    /// row carrying "+1", and the survivor is the rich `fix-pete` (most-recent).
    func testPeteFoldsToOneRowPlusOne() {
        let crew = SessionGrouping.groupByTier(sessions).first { $0.tier == .standingCrew }!.sessions
        let groups = SessionGrouping.groupTierByFolder(crew, folders: true,
                                                       orders: UITestFixtures.orders,
                                                       pinnedDirectories: UITestFixtures.pinned)
        let collapsed = SessionGrouping.collapseGroupsFoldingCrew(groups)
        let peteRows = collapsed.flatMap { $0.rows }.filter {
            SessionGrouping.canonicalNameKey($0.session) == "pete"
        }
        XCTAssertEqual(peteRows.count, 1, "two Pete tenures across cwds fold to ONE row")
        XCTAssertEqual(peteRows[0].session.id, UITestFixtures.peteId, "survivor = the most-recent rich Pete")
        XCTAssertEqual(peteRows[0].olderCount, 1, "the other-cwd tenure folds in as +1")
    }

    // MARK: Folding — ≥2 tiers, multiple cwds

    func testAtLeastTwoTiersPresent() {
        let tiers = Set(sessions.map { SessionGrouping.classifyTier($0) })
        XCTAssertGreaterThanOrEqual(tiers.count, 2, "folding needs ≥2 tiers")
        XCTAssertTrue(tiers.contains(.standingCrew), "standing-crew present (Pete)")
        XCTAssertTrue(tiers.contains(.drivers), "drivers present (Cartographer/Keystone)")
    }

    func testMultipleCwdsForFolderFolding() {
        let cwds = Set(sessions.compactMap { $0.cwd })
        XCTAssertGreaterThanOrEqual(cwds.count, 3, "≥3 distinct cwds so folder-fold has groups")
    }

    // MARK: Color/Status — idle / streaming / ended all present

    func testStatusSpread() {
        let statuses = Set(sessions.compactMap { $0.status })
        XCTAssertTrue(statuses.contains("idle"), "an idle session")
        XCTAssertTrue(statuses.contains("streaming"), "a streaming session")
        XCTAssertTrue(statuses.contains("ended"), "an ended session")
    }

    // MARK: StatusRow — a long status string (chip truncation)

    func testLongStatusSessionExists() {
        let s = byId(UITestFixtures.longStatusId)!
        XCTAssertGreaterThan((s.status ?? "").count, 30, "status long enough to force chip truncation")
    }

    // MARK: CardRichness — git + processes + token/cost stats on one card

    func testRichCardHasGitProcessesAndStats() {
        let s = byId(UITestFixtures.peteId)!
        XCTAssertEqual(s.gitBranch, "feat/native-ios-tests")
        XCTAssertNotNil(s.gitPrNumber)
        XCTAssertEqual(s.processes?.count, 2, "process list present")
        XCTAssertNotNil(s.tokensIn); XCTAssertNotNil(s.tokensOut); XCTAssertNotNil(s.cost)
        XCTAssertEqual(s.unread, true, "unread → the ReadPosition/unread-divider fixture")
    }

    // MARK: Chat/ReadPosition/ModelPicker/Separation — a scripted transcript

    func testPeteChatHasUserAssistantAndTool() {
        let chat = UITestFixtures.chat(for: UITestFixtures.peteId)
        XCTAssertFalse(chat.messages.isEmpty, "Pete has a scripted chat")
        XCTAssertTrue(chat.messages.contains { $0.role == .user }, "a user message")
        XCTAssertTrue(chat.messages.contains { $0.role == .assistant }, "an assistant message")
        XCTAssertTrue(chat.messages.contains { $0.role == .toolResult }, "a tool call")
    }

    func testNonScriptedSessionHasEmptyChat() {
        XCTAssertTrue(UITestFixtures.chat(for: UITestFixtures.keystoneId).messages.isEmpty,
                      "sessions without a scripted chat → empty state")
    }

    func testModelPresentForModelPicker() {
        // ModelPicker asserts a model label renders — the rich session carries one.
        XCTAssertEqual(byId(UITestFixtures.peteId)!.model, "anthropic/claude-opus-4")
    }

    // MARK: composer-overflow probe constants (shared with the app + SwiftPilot)

    func testComposerOverflowLaunchArgStable() {
        XCTAssertEqual(UITestFixtures.composerOverflowLaunchArg, "-uitest-composer-overflow")
    }

    func testComposerOverflowLineIsLongSingleLine() {
        let line = UITestFixtures.composerOverflowLine
        XCTAssertGreaterThan(line.count, 180, "long enough (~200) to overflow if it doesn't wrap")
        XCTAssertFalse(line.contains("\n"), "NO newline → only word-wrap can break it (proves the fix)")
    }

    func testOverflowProbeOpensFirstFixtureSession() {
        // The probe auto-opens sessions.first — assert that id is stable (fix-pete, which
        // also has the scripted chat so the composer renders over real content).
        XCTAssertEqual(UITestFixtures.sessions.first?.id, UITestFixtures.peteId)
    }
}
