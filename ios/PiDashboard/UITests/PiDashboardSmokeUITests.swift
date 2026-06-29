import XCTest

/// Minimal smoke (build CC owns a MINIMAL smoke per TEST-CONTRACT §E; the
/// comprehensive e2e suite is the cc-ios-tests session's). Drives the app via the
/// §A accessibility identifiers in `-uitest` fixture mode (hermetic — never touches
/// a live operator session). Captures the four brief screenshots.
final class PiDashboardSmokeUITests: XCTestCase {
    var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["-uitest"]
        app.launch()
    }

    /// F1+F2+F3+F4: connect → list (tier sections) → open session → composer
    /// single-row → type >20 wrapping chars → composer flips to multiline.
    func testSmokeConnectListChatComposerHysteresis() throws {
        // F1 — Connect screen prefilled, tap Connect.
        let urlField = app.textFields["connect-server-url"]
        XCTAssertTrue(urlField.waitForExistence(timeout: 10), "connect URL field shows")
        attachScreenshot(name: "01-connect")

        app.buttons["connect-submit"].tap()

        // F2 — session list with at least one tier section.
        let list = app.scrollViews["session-list"]
        XCTAssertTrue(list.waitForExistence(timeout: 10), "session list renders after connect")
        let anyTier = app.otherElements["tier-section-drivers"]
        XCTAssertTrue(anyTier.waitForExistence(timeout: 5), "a tier section renders")
        attachScreenshot(name: "02-list")

        // F3 — open the Cartographer (drivers) session.
        let card = app.buttons["session-card-fix-cartographer"]
        XCTAssertTrue(card.waitForExistence(timeout: 5), "session card present")
        card.tap()

        // composer single-row first.
        let composerCard = app.otherElements["mobile-composer-card"]
        XCTAssertTrue(composerCard.waitForExistence(timeout: 10), "composer visible after open")
        XCTAssertEqual(composerCard.value as? String, "single-row", "starts single-row")
        attachScreenshot(name: "03-chat-composer-single-row")

        // F4 — type >20 wrapping chars → flips to multiline (the hysteresis).
        let textView = app.textViews["mobile-composer-textarea"]
        XCTAssertTrue(textView.waitForExistence(timeout: 5))
        textView.tap()
        textView.typeText("This is a sufficiently long message that wraps across multiple lines on the iPhone composer width")

        let multiline = NSPredicate(format: "value == %@", "multiline")
        expectation(for: multiline, evaluatedWith: composerCard)
        waitForExpectations(timeout: 5)
        XCTAssertEqual(composerCard.value as? String, "multiline", "long wrapping text → multiline column")
        attachScreenshot(name: "04-chat-composer-multiline")
    }

    private func attachScreenshot(name: String) {
        let shot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
