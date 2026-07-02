import XCTest
import PiDashboardKit

/// Shared base for the durable XCUITest e2e suite (TEST-CONTRACT §A/§B, flows
/// F1–F7 + the regression gap-fill). Launches the app in HERMETIC FIXTURE MODE
/// (`-uitest-fixtures`): the app injects `UITestFixtures.sessions` + seeded chats,
/// marks the store connected, and boots STRAIGHT into the populated session list —
/// NO WebSocket, NO connect screen, NO live-dashboard dependency. This is the CI-green
/// fix: the old suite waited 60–114s per test on live-dashboard elements that don't
/// exist on a serverless CI runner; fixture mode renders everything instantly.
///
/// The fixture set is the SHARED CONTRACT (`hermetic-fixtures-brief.md`): `UITestFixtures`
/// lives in `PiDashboardKit`, so the app AND these tests import the SAME constants — zero
/// drift. Tests derive their subjects from `UITestFixtures.sessions` BY PROPERTY (status,
/// gitBranch, crew name) rather than hardcoding ids, so they stay correct as the fixture
/// set evolves; only the contract-stable crew name ("Pete") is named directly.
///
/// `@MainActor`-isolated: `XCUIApplication` / `XCUIElement` / `XCTestCase` driver APIs are
/// main-actor-isolated under Swift 6 strict concurrency (the app target sets SWIFT_VERSION
/// 6.0), so the whole UITest hierarchy must be too.
@MainActor
class PiDashboardUITestCase: XCTestCase {
    var app: XCUIApplication!

    /// The hermetic fixture launch args: `-uitest` keeps the store's mutation guards
    /// active (send/abort/resume/spawn stay no-ops — the suite can NEVER touch a live
    /// session), and `-uitest-fixtures` injects `UITestFixtures.sessions` + boots straight
    /// into the connected, populated list (bypassing the connect screen).
    static let fixtureArgs = ["-uitest", "-uitest-fixtures"]

    /// Launch in hermetic fixture mode (the default for every flow). Pass explicit args
    /// (e.g. `["-uitest"]` alone, or `[]`) for the connect-screen / live-error variants
    /// that deliberately exercise the pre-fixtures boot path.
    @discardableResult
    func launch(_ extraArgs: [String] = fixtureArgs) -> XCUIApplication {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = extraArgs
        app.launch()
        self.app = app
        return app
    }

    /// Launch hermetically in fixture mode with initial `UserDefaults` values FORCED via
    /// the NSArgumentDomain (highest-precedence on read, volatile per-launch, never written
    /// to disk). Pins state the app reads once at init — the persisted theme mode
    /// (`ThemeController`) and the hide-ended toggle (`DashboardStore.hideEnded`) — WITHOUT
    /// an app-side test hook and WITHOUT leaking into a sibling test. `didSet` persistence
    /// does not fire on init, so the on-disk store stays clean; a later in-app toggle writes
    /// the standard domain but the arg domain still shadows it on the NEXT launch.
    ///
    /// - Parameters:
    ///   - themeMode: `"system"`/`"dark"`/`"light"` → `pi.dashboard.themeMode`.
    ///   - hideEnded: forces `pi.dashboard.hideEnded` (`YES`/`NO`).
    @discardableResult
    func launchForcing(themeMode: String? = nil, hideEnded: Bool? = nil,
                       extra: [String] = []) -> XCUIApplication {
        var args = Self.fixtureArgs
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
    func waitFor(_ id: String, _ timeout: TimeInterval = 8) -> XCUIElement {
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

    // MARK: fixture-derived subjects (the SHARED CONTRACT — single source of truth)

    /// All fixture sessions the app boots with (`UITestFixtures.sessions`). The tests'
    /// authoritative session set — asserting `session-card-<s.id>` for these is exactly
    /// what the app renders under `-uitest-fixtures`.
    var fixtureSessions: [DashboardSession] { UITestFixtures.sessions }

    /// The `session-card-<id>` identifier for a fixture session.
    func cardId(_ session: DashboardSession) -> String { "session-card-\(session.id)" }

    /// The first fixture session matching `predicate` (by property — status, gitBranch,
    /// name, …). Fails the test with a clear message when the fixture set lacks one, so a
    /// coverage regression in `UITestFixtures` surfaces as a precise failure, not a crash.
    func fixtureSession(_ why: String,
                        where predicate: (DashboardSession) -> Bool) -> DashboardSession {
        guard let s = UITestFixtures.sessions.first(where: predicate) else {
            XCTFail("UITestFixtures has no session for: \(why)")
            return UITestFixtures.sessions.first ?? DashboardSession(id: "fix-missing")
        }
        return s
    }

    /// A fixture session with a given raw `status` (idle/streaming/ended/active).
    func fixtureSession(status: String) -> DashboardSession {
        fixtureSession("status == \(status)") { $0.status == status }
    }

    /// The two same-crew tenures the crew-collapse fold folds to one row (contract: the
    /// standing-crew name "Pete" in ≥2 cwds). Returns every fixture session named Pete.
    func peteTenures() -> [DashboardSession] {
        UITestFixtures.sessions.filter { $0.name == "Pete" }
    }

    // MARK: shared flow helpers (fixtures-boot → list; connect fallback)

    /// Land on the populated session list. Under `-uitest-fixtures` the app boots
    /// connected, so the list is up immediately — no connect tap. Falls back to the
    /// connect-submit path for a non-fixtures launch (the F1 connect-screen variant).
    @discardableResult
    func connectAndEnterList() -> XCUIElement {
        if el("session-list").waitForExistence(timeout: 8) {
            return el("session-list")
        }
        // Non-fixtures boot (connect-screen variant): submit the prefilled localhost URL.
        if el("connect-submit").waitForExistence(timeout: 4) {
            el("connect-submit").tap()
        }
        return waitFor("session-list")
    }

    /// Tap a `session-card-<id>` and wait for the chat surface (`chat-scroll` +
    /// `mobile-composer`) to mount. Returns once the composer is up.
    func openChat(cardId: String) {
        waitFor(cardId, 8).tap()
        _ = waitFor("chat-scroll", 10)
        _ = waitFor("mobile-composer", 10)
    }

    /// Open the chat for a fixture session (derives the card id from the session).
    func openChat(_ session: DashboardSession) { openChat(cardId: cardId(session)) }

    /// Open the first fixture session whose chat renders message rows, and return its id.
    /// The contract seeds ≥1 session with a multi-message `chat(for:)`; this finds it by
    /// opening candidates until one shows `chat-message-*` rows (robust to which id it is,
    /// and to the `chat(for:)` return shape). Fails clearly if none render rows.
    @discardableResult
    func openChatBearing() -> String {
        for s in fixtureSessions {
            let card = cardId(s)
            guard el(card).exists || waitForAppear(card, 2) else { continue }
            el(card).tap()
            if waitForAppear("chat-scroll", 6), hasChatRows() {
                _ = waitFor("mobile-composer", 8)
                return s.id
            }
            let back = app.navigationBars.buttons.firstMatch
            if back.exists { back.tap() }
            _ = waitForAppear("session-list", 4)
        }
        XCTFail("UITestFixtures has no session whose chat(for:) renders message rows")
        return ""
    }

    /// True when ≥1 real chat message row (`chat-message-<id>`, excluding sub-markers) is
    /// currently rendered.
    func hasChatRows() -> Bool {
        app.descendants(matching: .any).allElementsBoundByIndex.contains { e in
            let id = e.identifier
            return id.hasPrefix("chat-message-")
                && id != "chat-message-time" && id != "chat-message-pending"
                && id != "chat-message-failed"
        }
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
            usleep(150_000)
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
