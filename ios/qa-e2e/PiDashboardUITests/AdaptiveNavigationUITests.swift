import XCTest
import UIKit
import PiDashboardKit

@MainActor
final class AdaptiveNavigationUITests: PiDashboardUITestCase {
    func testPhonePortraitStillPushesAndPopsChat() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Requires iPhone portrait")
        XCUIDevice.shared.orientation = .portrait
        launch()
        connectAndEnterList()

        let subject = fixtureSession(status: "streaming")
        revealCard(subject)
        openChat(subject)
        XCTAssertFalse(el("list-search").isHittable)
        XCTAssertFalse(app.staticTexts["Select a session"].exists)

        let back = app.navigationBars.buttons.firstMatch
        XCTAssertTrue(back.waitForExistence(timeout: 5))
        back.tap()
        XCTAssertTrue(waitFor("list-search").isHittable)
        XCTAssertTrue(waitForGone("mobile-composer"))
        openChat(subject)
        XCTAssertTrue(waitFor("mobile-composer-textarea").isHittable)
    }

    func testTabletShowsSidebarBesideEmptyDetail() throws {
        try launchTablet()

        let empty = app.staticTexts["Select a session"]
        XCTAssertTrue(empty.waitForExistence(timeout: 5))
        let list = waitFor("session-list")
        XCTAssertLessThan(list.frame.maxX, empty.frame.minX)
        XCTAssertGreaterThan(app.windows.firstMatch.frame.width, 900)
        XCTAssertTrue(waitFor("settings-button").isHittable)
        XCTAssertTrue(waitFor("new-session-button").isHittable)
        XCTAssertFalse(exists("mobile-composer"))
    }

    func testTabletSelectionReplacesDetailAndKeepsSessionDraftsSeparate() throws {
        try launchTablet()
        let first = fixtureSession("first chat") { $0.id == UITestFixtures.peteId }
        let second = fixtureSession("second chat") { $0.id == UITestFixtures.cartographerId }

        revealCard(first)
        openChat(first)
        XCTAssertFalse(app.staticTexts["Select a session"].exists)
        let composer = waitFor("mobile-composer-textarea")
        composer.tap()
        composer.typeText("tablet draft")
        XCTAssertTrue(waitFor("list-search").isHittable)
        XCTAssertLessThan(waitFor("session-list").frame.maxX, composer.frame.minX)

        revealCard(second)
        openChat(second)
        XCTAssertTrue(app.navigationBars[second.displayName].waitForExistence(timeout: 5))
        XCTAssertNotEqual(waitFor("mobile-composer-textarea").value as? String, "tablet draft")
        XCTAssertTrue(waitFor("list-search").isHittable)

        revealCard(first)
        openChat(first)
        XCTAssertTrue(app.navigationBars[first.displayName].waitForExistence(timeout: 5))
        XCTAssertEqual(waitFor("mobile-composer-textarea").value as? String, "tablet draft")
    }

    func testTabletSettingsAndNewSessionRemainSheets() throws {
        try launchTablet()
        let windowWidth = app.windows.firstMatch.frame.width

        waitFor("settings-button").tap()
        let settings = waitFor("settings-view")
        XCTAssertLessThan(settings.frame.width, windowWidth)
        let trace = el("settings-connection-trace")
        for _ in 0..<5 {
            if trace.exists && trace.isHittable { break }
            settings.swipeUp()
        }
        XCTAssertTrue(trace.isHittable)
        trace.tap()
        XCTAssertTrue(waitFor("socket-trace-copy").isHittable)
        app.navigationBars.buttons["Settings"].tap()
        waitFor("settings-done").tap()
        XCTAssertTrue(waitForGone("settings-view"))

        waitFor("new-session-button").tap()
        XCTAssertLessThan(waitFor("new-session-sheet").frame.width, windowWidth)
        app.buttons["Done"].firstMatch.tap()
        XCTAssertTrue(waitForGone("new-session-sheet"))
        XCTAssertTrue(waitFor("list-search").isHittable)
    }

    private func launchTablet() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .pad, "Requires iPad")
        XCUIDevice.shared.orientation = .landscapeLeft
        addTeardownBlock { @MainActor in
            XCUIDevice.shared.orientation = .portrait
        }
        launch()
        connectAndEnterList()
    }
}
