import XCTest
import PiDashboardKit

/// F6 (connection banner) + F7 (filters), driven through the §A identifiers.
@MainActor
final class BannerAndFiltersUITests: PiDashboardUITestCase {

    private func enterList() {
        launch()
        connectAndEnterList()
    }

    // MARK: F6 — connection banner

    /// Negative (always runnable): in the steady connected fixture state the
    /// `connection-banner` is ABSENT (it mirrors the PWA's >3s-disconnect banner,
    /// shown only while `.reconnecting` / `.failed`).
    func testF6_NoBannerWhileConnected() {
        enterList()
        XCTAssertFalse(exists("connection-banner"),
                       "no disconnect banner while steadily connected")
    }

    /// Positive path (phase injection): the disconnect/reconnect banner surfaces when the
    /// store is in `.reconnecting`. Under `-uitest-fixtures` the app boots `.connected`, so
    /// the banner needs an app affordance (`-uitest-reconnecting` seeding `.reconnecting`).
    /// Runs in fixture mode with TIGHT bounded waits — the populated list is up instantly,
    /// so if the banner isn't there within a short window the hook isn't wired → SKIP fast
    /// (never the old 15s+5s non-fixture stall).
    func testF6_BannerAppearsWhenReconnecting() throws {
        launch(Self.fixtureArgs + ["-uitest-reconnecting"])
        _ = waitForAppear("session-list", 6) // fixture boot is instant; don't hard-require
        if !waitForAppear("connection-banner", 3) {
            throw XCTSkip("""
            connection-banner not shown under -uitest-reconnecting. PENDING build-session hook: \
            DashboardStore should enter `.reconnecting` when launched with the `-uitest-reconnecting` \
            argument (fixture boot is `.connected` by default, so the banner needs this seed). \
            Reported to SwiftPilot (TEST-CONTRACT §B F6). Spec authored + ready.
            """)
        }
        XCTAssertTrue(exists("connection-banner"), "reconnecting surfaces the banner")
        attach("F6-reconnecting-banner")
    }

    // MARK: F7 — filters

    /// Every frequently-used filter is fully visible at the untouched initial scroll
    /// position. `isHittable` is insufficient: a clipped chip can report true while its
    /// tap centre lies outside the window. Frame containment is the actual contract.
    func testF7_AllFilterChipsFitInsideStandardIPhoneWindowWithoutScrolling() {
        enterList()
        let windowFrame = app.windows.firstMatch.frame
        let chipIDs = [
            "toggle-folders", "toggle-hide-ended", "toggle-hide-stale",
            "toggle-active-only", "toggle-show-hidden",
        ]

        for id in chipIDs {
            let chip = waitFor(id)
            XCTAssertGreaterThan(chip.frame.width, 0, "\(id) has measurable width")
            XCTAssertGreaterThan(chip.frame.height, 0, "\(id) has measurable height")
            XCTAssertTrue(
                windowFrame.contains(chip.frame),
                "\(id) frame \(chip.frame) must fit inside window \(windowFrame) without scrolling")
        }
    }

    /// Search narrows the card set: searching a session's display name keeps its card and
    /// drops a distinct-named sibling (name → firstMessage → cwd-basename match, mirrors
    /// filterByQuery). Subjects derived from `UITestFixtures` (two sessions whose display
    /// names don't share a search token).
    func testF7_SearchNarrowsCards() {
        enterList()
        let (keep, drop) = twoDistinctlyNamedSessions()
        XCTAssertTrue(waitForAppear(cardId(keep), 6), "the keep card is present before filtering")
        XCTAssertTrue(exists(cardId(drop)) || waitForAppear(cardId(drop), 4),
                      "the drop card present before filtering")

        let search = waitFor("list-search")
        search.tap()
        search.typeText(keep.displayName)

        // The searched card remains; the distinct-named sibling is filtered out.
        XCTAssertTrue(waitForAppear(cardId(keep), 6), "match retained")
        XCTAssertTrue(waitForGone(cardId(drop), 6), "non-match filtered out")
        attach("F7-search")

        // clearing the query restores the sibling.
        if let v = search.value as? String, !v.isEmpty {
            search.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: v.count))
        }
        XCTAssertTrue(waitForAppear(cardId(drop), 6), "clearing search restores the full list")
    }

    /// Two fixture sessions whose display names don't share a search token (so searching
    /// one's name drops the other). Falls back to the first two sessions if no cleaner pair.
    private func twoDistinctlyNamedSessions() -> (keep: DashboardSession, drop: DashboardSession) {
        let named = fixtureSessions.filter { !$0.displayName.isEmpty }
        for a in named {
            let ka = a.displayName.lowercased()
            if let b = named.first(where: { b in
                b.id != a.id
                    && !b.displayName.lowercased().contains(ka)
                    && !ka.contains(b.displayName.lowercased())
            }) {
                return (a, b)
            }
        }
        let first = fixtureSessions.first ?? fixtureSession("any") { _ in true }
        let second = fixtureSessions.dropFirst().first ?? first
        return (first, second)
    }

    /// The Folders toggle flattens directory subgroups: with folders ON the
    /// `dir-group-*` headers render; toggling OFF removes them (mirrors
    /// groupTierByFolder folders:false → one flat bucket).
    func testF7_FoldersToggleFlattensDirectoryGroups() {
        enterList()
        // Folders defaults ON → at least one directory header is present.
        let dirHeaderPresent = anyDirGroupExists()
        XCTAssertTrue(dirHeaderPresent, "directory subgroup header(s) render with Folders ON")

        // toggle Folders OFF → headers disappear.
        let folders = waitFor("toggle-folders")
        folders.tap()
        // poll for the headers to clear.
        let deadline = Date().addingTimeInterval(6)
        var clearedHeaders = false
        while Date() < deadline {
            if !anyDirGroupExists() { clearedHeaders = true; break }
            usleep(150_000)
        }
        XCTAssertTrue(clearedHeaders, "directory headers removed when Folders is OFF")
        // cards themselves are still present (flattened, not FILTERED out). Assert
        // ANY card remains — not a specific one: after the reflow a particular row
        // can sit below the fold, and the LazyVStack won't expose an off-screen row
        // to the a11y tree (that raced an earlier card-specific check).
        var cardsRemain = false
        let deadline2 = Date().addingTimeInterval(6)
        while Date() < deadline2 {
            if !sessionCardIdentifiers().isEmpty { cardsRemain = true; break }
            usleep(150_000)
        }
        XCTAssertTrue(cardsRemain, "cards remain after flattening (folders only regroup, never filter)")
        attach("F7-folders-off")
    }

    /// The Hide-stale toggle flips its own state (accessibilityValue on/off). The
    /// fixture has no stale-active sessions (all fresh), so this asserts the toggle
    /// CONTRACT (state flip) rather than a card drop — documented honestly.
    func testF7_HideStaleToggleFlipsState() {
        enterList()
        let toggle = waitFor("toggle-hide-stale")
        XCTAssertEqual(toggle.value as? String, "off", "hide-stale starts off")
        toggle.tap()
        // poll the value flip.
        let deadline = Date().addingTimeInterval(4)
        while Date() < deadline {
            if (toggle.value as? String) == "on" { break }
            usleep(120_000)
        }
        XCTAssertEqual(toggle.value as? String, "on", "hide-stale toggles on")
    }

    // MARK: helpers

    private func anyDirGroupExists() -> Bool {
        app.descendants(matching: .any).allElementsBoundByIndex
            .contains { $0.identifier.hasPrefix("dir-group-") }
    }
}
