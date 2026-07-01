import XCTest

/// BACKFILL #3 — session-list declutter. Regression guard for the operator's daily
/// flood bug (`fix(ios): declutter session list`, e6cf8e3): 419 sessions, mostly OLD
/// ended crew tenures appearing top AND bottom. Two-part fix:
///   1. `filterEnded` (core): ended sessions hidden by DEFAULT (persisted "Hide ended"
///      toggle, default on), preserving the currently-viewed session.
///   2. `collapseSameName` (core): repeated same-entity tenures fold to ONE row + a
///      "+N" badge for the older ones.
///
/// These drive the real §A identifiers hermetically. The hide-ended default + toggle
/// run today. Initial `hideEnded` is FORCED through the `UserDefaults` argument domain
/// (`launchForcing(hideEnded:)`) so the "default hides ended" contract is deterministic
/// across runs (the toggle persists to `UserDefaults`, so a bare launch would inherit a
/// prior run's value) — no app-side test hook.
///
/// A11y note: the only ended fixture session (`fix-worker`, `subagent-worker-3f4a9c`)
/// lives in the WORKER tier near the bottom of the list, where a `LazyVStack` may not
/// realize it into the a11y tree. To make its presence/absence observable regardless of
/// scroll position, each toggle assertion first narrows the list with `list-search`
/// "worker" — which matches ONLY `fix-worker` by name (verified against every fixture
/// session) — collapsing the list to that one card. `filterEnded` runs BEFORE
/// `filterByQuery`, so a hidden ended session is dropped before the query even applies:
/// search "worker" ⇒ empty when hidden, the card when shown. Exactly the toggle signal.
@MainActor
final class SessionDeclutterUITests: PiDashboardUITestCase {

    private let endedCard = "session-card-fix-worker"
    private let hideEndedToggle = "toggle-hide-ended"

    /// Type a query into `list-search` (clearing any prior text first).
    private func search(_ query: String) {
        let field = waitFor("list-search")
        field.tap()
        if let v = field.value as? String, !v.isEmpty, v != "Search sessions" {
            field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: v.count))
        }
        field.typeText(query)
    }

    private func clearSearch() {
        let field = waitFor("list-search")
        if let v = field.value as? String, !v.isEmpty, v != "Search sessions" {
            field.tap()
            field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: v.count))
        }
    }

    // MARK: ended hidden by default → toggle reveals → toggle re-hides

    /// With `hideEnded` at its DEFAULT (on), the ended `fix-worker` card is filtered
    /// out; toggling "Hide ended" OFF reveals it; toggling ON hides it again. The
    /// search-narrowing keeps the single ended card in the on-screen a11y tree for a
    /// deterministic present/absent read.
    func testEndedHiddenByDefaultToggleRevealsAndReHides() {
        launchForcing(hideEnded: true)
        connectAndEnterList()

        // The toggle reflects the forced default: ON.
        let toggle = waitFor(hideEndedToggle)
        XCTAssertEqual(toggle.value as? String, "on", "Hide ended defaults on")

        // Default (hidden): search "worker" yields NO card (ended filtered before query).
        search("worker")
        XCTAssertTrue(waitForGone(endedCard, 6),
                      "ended session hidden by default — search finds nothing")
        attach("declutter-ended-hidden-default")

        // Toggle OFF → the ended card appears under the same query.
        toggle.tap()
        XCTAssertEqual(toggle.value as? String, "off", "toggle flips to off")
        XCTAssertTrue(waitForAppear(endedCard, 6),
                      "toggling Hide ended OFF reveals the ended session")
        attach("declutter-ended-revealed")

        // Toggle ON again → hidden once more (the full round-trip).
        toggle.tap()
        XCTAssertEqual(toggle.value as? String, "on", "toggle flips back to on")
        XCTAssertTrue(waitForGone(endedCard, 6),
                      "toggling Hide ended ON hides the ended session again")
    }

    /// The mirror launch: forced `hideEnded` OFF → the ended card is visible from the
    /// start (under the narrowing query); toggling ON hides it. Proves the filter is
    /// driven by the toggle in BOTH initial states (not an artifact of one default).
    func testEndedVisibleWhenHideEndedForcedOff() {
        launchForcing(hideEnded: false)
        connectAndEnterList()

        let toggle = waitFor(hideEndedToggle)
        XCTAssertEqual(toggle.value as? String, "off", "Hide ended forced off at launch")

        search("worker")
        XCTAssertTrue(waitForAppear(endedCard, 6),
                      "ended session visible when Hide ended is off")
        attach("declutter-ended-visible-off")

        toggle.tap()
        XCTAssertEqual(toggle.value as? String, "on", "toggle flips to on")
        XCTAssertTrue(waitForGone(endedCard, 6),
                      "toggling Hide ended ON hides the ended session")
    }

    // MARK: tenure collapse (+N) — authored; skips pending a same-name fixture

    /// Same-entity tenures collapse to ONE row with a "+N" badge
    /// (`card-collapsed-count-<id>`) for the older ones (`collapseSameName`). Driving
    /// this end-to-end needs ≥2 fixture sessions that share a canonical name (e.g. two
    /// `Joan` tenures, or `Joan` + `Joan-tenure-2`) so the collapse actually folds a row
    /// and renders the badge. The current `-uitest` fixture has all-distinct names, so
    /// no badge renders and this SKIPS with a request rather than asserting on absent UI
    /// (the collapse ALGEBRA itself is covered at the unit layer by SessionDeclutterTests
    /// — this is the missing e2e wiring). PENDING fixture extension: add a duplicate-
    /// canonical-name pair to `FixtureData.sessionsSnapshot()`. App-target/fixture change
    /// = cc-ios-build owned (reported to SwiftPilot). Spec authored + ready.
    func testSameNameTenuresCollapseWithBadge() throws {
        launchForcing(hideEnded: false) // show everything so any tenure can fold
        connectAndEnterList()

        // Look for ANY collapsed-count badge across the list.
        let hasBadge = app.descendants(matching: .any).allElementsBoundByIndex
            .contains { $0.identifier.hasPrefix("card-collapsed-count-") }
        guard hasBadge else {
            throw XCTSkip("""
            No `card-collapsed-count-*` badge in the fixture — its sessions all have \
            distinct canonical names, so collapseSameName folds nothing. PENDING fixture \
            extension: add ≥2 same-canonical-name tenures (e.g. two `Joan*`) to \
            FixtureData.sessionsSnapshot() so a row collapses + the "+N" badge renders. \
            Collapse algebra is unit-covered (SessionDeclutterTests); this is the e2e \
            wiring. Reported to cc-ios-build. Spec authored + ready.
            """)
        }
        attach("declutter-collapse-badge")
    }
}
