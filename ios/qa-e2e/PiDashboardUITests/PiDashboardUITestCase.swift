import XCTest

/// Shared base for the durable XCUITest e2e suite (TEST-CONTRACT §A/§B, flows
/// F1–F7). Launches the app in the hermetic `-uitest` fixture mode (DashboardStore
/// loads bundled fixtures — NEVER touches a live operator session) and exposes
/// small, robust helpers the flow specs build on.
///
/// Run: see qa-e2e/README.md for the exact `xcodebuild test` invocation.
///
/// `@MainActor`-isolated: `XCUIApplication` / `XCUIElement` / `XCTestCase` driver
/// APIs are main-actor-isolated under Swift 6 strict concurrency (the app target
/// sets SWIFT_VERSION 6.0), so the whole UITest hierarchy must be too.
@MainActor
class PiDashboardUITestCase: XCTestCase {
    var app: XCUIApplication!

    /// Launch in fixture mode (default for the e2e flows). Pass extra args for
    /// the live-error / phase-injection variants.
    @discardableResult
    func launch(_ extraArgs: [String] = ["-uitest"]) -> XCUIApplication {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = extraArgs
        app.launch()
        self.app = app
        return app
    }

    /// Launch hermetically in `-uitest` fixture mode with initial `UserDefaults`
    /// values FORCED via the NSArgumentDomain (highest-precedence on read, volatile
    /// per-launch, never written to disk). This lets a spec pin state that the app
    /// reads once at init — the persisted theme mode (`ThemeController`) and the
    /// hide-ended toggle (`DashboardStore.hideEnded`) — WITHOUT any app-side test
    /// hook and WITHOUT leaking into a sibling test. `didSet` persistence does not
    /// fire on init, so the on-disk store stays clean; a later in-app toggle writes
    /// the standard domain but the arg domain still shadows it on the NEXT launch.
    ///
    /// - Parameters:
    ///   - themeMode: `"system"`/`"dark"`/`"light"` → `pi.dashboard.themeMode`.
    ///   - hideEnded: forces `pi.dashboard.hideEnded` (`YES`/`NO`).
    @discardableResult
    func launchForcing(themeMode: String? = nil, hideEnded: Bool? = nil,
                       extra: [String] = []) -> XCUIApplication {
        var args = ["-uitest"]
        if let themeMode { args += ["-pi.dashboard.themeMode", themeMode] }
        if let hideEnded { args += ["-pi.dashboard.hideEnded", hideEnded ? "YES" : "NO"] }
        args += extra
        return launch(args)
    }

    // MARK: element lookup (identifier-first, type-agnostic)

    /// First element with `id` across ANY element type — SwiftUI promotes custom
    /// views to varied trait types, so we never assume `.button` vs `.other`.
    func el(_ id: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: id).firstMatch
    }

    @discardableResult
    func waitFor(_ id: String, _ timeout: TimeInterval = 10) -> XCUIElement {
        let e = el(id)
        XCTAssertTrue(e.waitForExistence(timeout: timeout), "expected element '\(id)' to appear")
        return e
    }

    func exists(_ id: String) -> Bool { el(id).exists }

    /// Poll until `id` EXISTS (returns true) or the deadline passes (returns false) —
    /// the positive twin of `waitForGone`, without asserting. Same Sendable-safe
    /// deadline-poll shape (no self-capturing NSPredicate) that keeps Swift 6
    /// strict-concurrency clean.
    func waitForAppear(_ id: String, _ timeout: TimeInterval = 6) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if el(id).exists { return true }
            usleep(150_000) // 0.15s
        }
        return el(id).exists
    }

    // MARK: shared flow helpers (connect → list → open a chat)

    /// Connect via the prefilled localhost default and land on the session list.
    /// The single entry every list/chat flow shares. Assumes a `-uitest` launch.
    @discardableResult
    func connectAndEnterList() -> XCUIElement {
        waitFor("connect-submit").tap()
        return waitFor("session-list")
    }

    /// From the session list, tap a `session-card-<id>` and wait for the chat surface
    /// (`chat-scroll` + `mobile-composer`) to mount. Returns once the composer is up.
    func openChat(cardId: String) {
        waitFor(cardId, 8).tap()
        _ = waitFor("chat-scroll", 10)
        _ = waitFor("mobile-composer", 10)
    }

    /// Poll until the element with `id` no longer exists (a filter dropped it).
    /// A deadline poll — NOT `expectation(for:evaluatedWith:)`, whose `NSPredicate`
    /// is evaluated off the main actor and would capture this non-Sendable test
    /// case (a Swift 6 strict-concurrency hard error).
    func waitForGone(_ id: String, _ timeout: TimeInterval = 6) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if !el(id).exists { return true }
            usleep(150_000) // 0.15s
        }
        return !el(id).exists
    }

    /// The element carrying the composer layout value (`single-row`/`multiline`) —
    /// the dedicated `mobile-composer-card` a11y marker (TEST-CONTRACT §A).
    func composerLayoutValue() -> String? {
        el("mobile-composer-card").value as? String
    }

    /// Poll the composer layout value until it equals `expected` (SwiftUI updates
    /// the a11y value asynchronously after a text edit). No self-capturing
    /// NSPredicate — keeps Swift 6 strict-concurrency clean.
    @discardableResult
    func waitForComposerLayout(_ expected: String, timeout: TimeInterval = 6) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if composerLayoutValue() == expected { return true }
            usleep(150_000) // 0.15s
        }
        return composerLayoutValue() == expected
    }

    /// Count of currently-rendered session cards (any element whose id starts with
    /// `session-card-` and is not a sub-label like `session-card-name`).
    func sessionCardIdentifiers() -> [String] {
        let all = app.descendants(matching: .any).allElementsBoundByIndex
        return all.compactMap { e in
            let id = e.identifier
            return (id.hasPrefix("session-card-")
                    && !id.hasPrefix("session-card-name")
                    && !id.hasPrefix("session-card-status")
                    && !id.hasPrefix("session-card-context")
                    && !id.hasPrefix("session-card-model")
                    && !id.hasPrefix("session-card-unread")) ? id : nil
        }
    }

    /// Tap into a text input and replace its whole contents (handles the prefilled
    /// connect URL field; select-all + delete is the robust clear).
    func replaceText(_ element: XCUIElement, with newValue: String) {
        element.tap()
        if let current = element.value as? String, !current.isEmpty {
            let deletes = String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count)
            element.typeText(deletes)
        }
        element.typeText(newValue)
    }

    func attach(_ name: String) {
        let shot = XCUIScreen.main.screenshot()
        let a = XCTAttachment(screenshot: shot)
        a.name = name
        a.lifetime = .keepAlways
        add(a)
    }
}
