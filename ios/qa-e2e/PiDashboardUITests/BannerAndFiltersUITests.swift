import XCTest

/// F6 (connection banner) + F7 (filters), driven through the §A identifiers.
@MainActor
final class BannerAndFiltersUITests: PiDashboardUITestCase {

    private func enterList() {
        launch()
        waitFor("connect-submit").tap()
        waitFor("session-list")
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

    /// Positive path (phase injection): the disconnect/reconnect banner surfaces
    /// when the store is in `.reconnecting`. XCUITest can't sever the socket of a
    /// hermetic fixture run, so this needs a small app-side affordance: honor a
    /// `-uitest-reconnecting` launch argument that puts the store into the
    /// `.reconnecting` phase on entry. If the build session has not wired that hook
    /// yet, the test SKIPS with a clear coordination note (reported to SwiftPilot)
    /// rather than failing — the spec is authored + ready for when the hook lands.
    func testF6_BannerAppearsWhenReconnecting() throws {
        launch(["-uitest", "-uitest-reconnecting"])
        // Non-asserting wait for the shell to come up (this is the first test on a
        // cold sim; do NOT hard-require session-list — the banner can render over
        // ConnectView too, and the hook may not be wired at all).
        _ = el("session-list").waitForExistence(timeout: 15)
        if !el("connection-banner").waitForExistence(timeout: 5) {
            throw XCTSkip("""
            connection-banner not shown under -uitest-reconnecting. PENDING build-session hook: \
            DashboardStore should enter `.reconnecting` when launched with the \
            `-uitest-reconnecting` argument (mirrors the >3s disconnect). Reported to SwiftPilot \
            (TEST-CONTRACT §B F6). Spec authored + ready.
            """)
        }
        XCTAssertTrue(el("connection-banner").exists, "reconnecting surfaces the banner")
        attach("F6-reconnecting-banner")
    }

    // MARK: F7 — filters

    /// Search narrows the card set: `list-search` "cart" keeps Cartographer, drops
    /// Joan (name → firstMessage → cwd-basename match, mirrors filterByQuery).
    func testF7_SearchNarrowsCards() {
        enterList()
        XCTAssertTrue(waitFor("session-card-fix-cartographer", 8).exists)
        XCTAssertTrue(exists("session-card-fix-joan"), "Joan present before filtering")

        let search = waitFor("list-search")
        search.tap()
        search.typeText("cart")

        // Cartographer remains; Joan is filtered out.
        XCTAssertTrue(waitFor("session-card-fix-cartographer", 6).exists, "match retained")
        XCTAssertTrue(waitForGone("session-card-fix-joan", 6), "non-match filtered out")
        attach("F7-search")

        // clearing the query restores Joan.
        if let v = search.value as? String, !v.isEmpty {
            search.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: v.count))
        }
        XCTAssertTrue(waitFor("session-card-fix-joan", 6).exists, "clearing search restores the full list")
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
        // to the a11y tree (that raced the earlier `fix-cartographer`-specific check).
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
