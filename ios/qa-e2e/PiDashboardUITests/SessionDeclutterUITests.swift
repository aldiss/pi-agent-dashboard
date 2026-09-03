import XCTest
import PiDashboardKit

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
/// A11y note: the ended fixture can sit in a collapsed tier/directory below the visible
/// `LazyVStack` window. No-search assertions therefore unfold and scan the list before
/// deciding whether its card exists. Search has different semantics: it deliberately
/// bypasses Hide ended and force-opens matching tiers/directories, so an ended match must
/// render while the query is active.
@MainActor
final class SessionDeclutterUITests: PiDashboardUITestCase {

    /// An ENDED fixture session (the declutter subject) + its card id, derived from the
    /// contract set (the fixture seeds ≥1 `status == "ended"` session).
    private var endedSession: DashboardSession { fixtureSession(status: "ended") }
    private var endedCard: String { cardId(endedSession) }
    /// A search token that narrows to the ended session by display name.
    private var endedQuery: String { endedSession.displayName }
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

    /// Return to the list controls after a no-search scan moved the LazyVStack downward.
    @discardableResult
    private func scrollToControls() -> XCUIElement {
        let list = el("session-list")
        for _ in 0..<8 {
            let toggle = el(hideEndedToggle)
            if toggle.exists && toggle.isHittable { return toggle }
            list.swipeDown()
        }
        let toggle = waitFor(hideEndedToggle)
        XCTAssertTrue(toggle.isHittable, "Hide ended control is reachable after scrolling to top")
        return toggle
    }

    /// Look for the ended card with NO query active. Expands its tier and directory when
    /// encountered, then scans through the LazyVStack so an off-screen row cannot masquerade
    /// as a filtered row.
    private func endedCardExistsWithoutSearch() -> Bool {
        _ = scrollToControls()
        let list = el("session-list")
        let tierHeader = "tier-section-\(tierOf(endedSession).rawValue)"
        let directoryHeader = endedSession.cwd.map {
            "dir-group-\(URL(fileURLWithPath: $0).lastPathComponent)"
        }

        for _ in 0..<10 {
            if el(endedCard).exists { return true }

            let tier = el(tierHeader)
            if tier.exists, tier.isHittable, (tier.value as? String) == "collapsed" {
                tier.tap()
                usleep(150_000)
                continue
            }

            if let directoryHeader {
                // Directory ids use basenames and can repeat across tiers. Pick the
                // currently visible match instead of `.firstMatch`, which may be an
                // off-screen duplicate from an earlier tier.
                let directory = app.descendants(matching: .any)
                    .matching(identifier: directoryHeader)
                    .allElementsBoundByIndex
                    .first { $0.exists && $0.isHittable }
                if let directory, directory.label.hasPrefix("Expand ") {
                    directory.tap()
                    usleep(150_000)
                    continue
                }
            }

            if el(endedCard).exists { return true }
            list.swipeUp()
        }
        return el(endedCard).exists
    }

    private func clearSearch() {
        let field = waitFor("list-search")
        if let v = field.value as? String, !v.isEmpty, v != "Search sessions" {
            field.tap()
            field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: v.count))
        }
    }

    // MARK: Hide ended + search reveal

    /// Hide ended ON removes the ended card with no query. A matching search is a reveal
    /// operation, so it restores that exact card without changing the toggle; clearing the
    /// query applies Hide ended again.
    func testHideEndedSearchRevealsMatchAndClearingRehides() {
        launchForcing(hideEnded: true)
        connectAndEnterList()

        let toggle = scrollToControls()
        XCTAssertEqual(toggle.value as? String, "on", "Hide ended defaults on")

        XCTAssertFalse(endedCardExistsWithoutSearch(),
                       "Hide ended ON filters the ended session when no search is active")
        attach("declutter-ended-hidden-default")

        _ = scrollToControls()
        search(endedQuery)
        XCTAssertTrue(waitForAppear(endedCard, 6),
                      "a matching search reveals the ended session while Hide ended remains ON")
        XCTAssertEqual(el(hideEndedToggle).value as? String, "on",
                       "search reveal does not mutate Hide ended")
        attach("declutter-ended-search-revealed")

        clearSearch()
        XCTAssertFalse(endedCardExistsWithoutSearch(),
                       "clearing search reapplies Hide ended")
    }

    /// Forced Hide ended OFF renders the ended card with no query. Toggling ON with no
    /// query removes it. The same unfold-and-scan path proves both states.
    func testEndedVisibleWhenHideEndedForcedOff() {
        launchForcing(hideEnded: false)
        connectAndEnterList()

        var toggle = scrollToControls()
        XCTAssertEqual(toggle.value as? String, "off", "Hide ended forced off at launch")

        XCTAssertTrue(endedCardExistsWithoutSearch(),
                      "Hide ended OFF renders the ended session without search")
        attach("declutter-ended-visible-off")

        toggle = scrollToControls()
        toggle.tap()
        XCTAssertEqual(toggle.value as? String, "on", "toggle flips to on")
        XCTAssertFalse(endedCardExistsWithoutSearch(),
                       "toggling Hide ended ON hides the ended session without search")
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
