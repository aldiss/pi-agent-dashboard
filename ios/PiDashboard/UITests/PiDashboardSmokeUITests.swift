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
        let anyTier = app.descendants(matching: .any)["tier-section-drivers"]
        XCTAssertTrue(anyTier.waitForExistence(timeout: 5), "a tier section renders")
        attachScreenshot(name: "02-list")

        // F3 — open the Cartographer (drivers) session.
        let card = app.descendants(matching: .any)["session-card-fix-cartographer"]
        XCTAssertTrue(card.waitForExistence(timeout: 5), "session card present")
        card.tap()

        // composer single-row first. The layout value (single-row/multiline) rides
        // on `mobile-composer-card`; some SwiftUI a11y trees promote it to the outer
        // `mobile-composer` — resolve whichever carries it.
        let composer = layoutElement()
        XCTAssertTrue(composer.waitForExistence(timeout: 10), "composer visible after open")
        XCTAssertEqual(composer.value as? String, "single-row", "starts single-row")
        attachScreenshot(name: "03-chat-composer-single-row")

        // F4 — type >20 wrapping chars → flips to multiline (the hysteresis).
        let textView = app.descendants(matching: .any).matching(identifier: "mobile-composer-textarea").firstMatch
        XCTAssertTrue(textView.waitForExistence(timeout: 5), "composer text input present")
        textView.tap()
        textView.typeText("This is a sufficiently long message that wraps across multiple lines on the iPhone composer width")

        // Poll the layout value until it flips (no self-capturing predicate —
        // keeps Swift 6 strict-concurrency happy).
        var flipped = false
        for _ in 0..<25 {
            if layoutElement().value as? String == "multiline" { flipped = true; break }
            usleep(200_000) // 0.2s
        }
        XCTAssertTrue(flipped, "long wrapping text → multiline column")
        attachScreenshot(name: "04-chat-composer-multiline")
    }

    /// Resolve the element carrying the composer layout value — the dedicated
    /// `mobile-composer-card` marker (canonical per TEST-CONTRACT §A). `.firstMatch`
    /// keeps it unambiguous.
    private func layoutElement() -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: "mobile-composer-card").firstMatch
    }

    private func attachScreenshot(name: String) {
        let shot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
