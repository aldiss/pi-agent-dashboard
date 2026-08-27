import XCTest
@testable import PiDashboardKit

final class ComposerDraftStoreTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suite: String!

    override func setUp() {
        super.setUp()
        suite = "ComposerDraftStoreTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)!
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
        defaults = nil
        suite = nil
        super.tearDown()
    }

    func testDraftsPersistAndStayIsolatedPerSession() {
        ComposerDraftStore.save("alpha", sessionId: "a", defaults: defaults)
        ComposerDraftStore.save("beta", sessionId: "b", defaults: defaults)
        XCTAssertEqual(ComposerDraftStore.load(sessionId: "a", defaults: defaults), "alpha")
        XCTAssertEqual(ComposerDraftStore.load(sessionId: "b", defaults: defaults), "beta")
    }

    func testSavingEmptyRemovesPersistedDraft() {
        ComposerDraftStore.save("draft", sessionId: "s", defaults: defaults)
        ComposerDraftStore.save("", sessionId: "s", defaults: defaults)
        XCTAssertEqual(ComposerDraftStore.load(sessionId: "s", defaults: defaults), "")
    }

    func testMissingDraftLoadsEmpty() {
        XCTAssertEqual(ComposerDraftStore.load(sessionId: "missing", defaults: defaults), "")
    }
}
