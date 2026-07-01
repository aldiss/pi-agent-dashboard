import XCTest
@testable import PiDashboardKit

/// Cluster 3 — WCAG contrast helper correctness + the light-mode palette audit. The
/// palette assertions FAIL if a light-mode token regresses below AA, so the fix can't
/// silently rot. Pure math, `swift test`, no rendering.
final class ContrastTests: XCTestCase {

    // MARK: helper math

    func testRatioKnownPairs() {
        XCTAssertEqual(Contrast.ratio("#000000", "#ffffff")!, 21.0, accuracy: 0.01, "black/white = 21:1")
        XCTAssertEqual(Contrast.ratio("#ffffff", "#ffffff")!, 1.0, accuracy: 0.001, "same colour = 1:1")
        // Symmetric — order doesn't matter.
        XCTAssertEqual(Contrast.ratio("#1a1a1a", "#ffffff")!, Contrast.ratio("#ffffff", "#1a1a1a")!, accuracy: 0.0001)
    }

    func testShorthandAndAlphaHexParse() {
        XCTAssertEqual(Contrast.ratio("#fff", "#000")!, 21.0, accuracy: 0.01, "#rgb shorthand expands")
        // #rrggbbaa drops alpha (contrast on the opaque colour).
        XCTAssertEqual(Contrast.relativeLuminance("#ffffffff"), Contrast.relativeLuminance("#ffffff"))
    }

    func testUnparseableIsNilNeverFalsePass() {
        XCTAssertNil(Contrast.ratio("rgba(0,0,0,0.06)", "#ffffff"), "rgba(...) → unknown")
        XCTAssertNil(Contrast.relativeLuminance("not-a-color"))
        XCTAssertFalse(Contrast.meetsAA(foreground: "rgba(0,0,0,0.06)", background: "#ffffff", largeOrUI: true),
                       "unparseable never passes AA")
    }

    func testMeetsAAThresholds() {
        // #777 on white = 4.48:1 → passes UI (3.0) but not text (4.5).
        XCTAssertTrue(Contrast.meetsAA(foreground: "#777777", background: "#ffffff", largeOrUI: true))
        XCTAssertFalse(Contrast.meetsAA(foreground: "#777777", background: "#ffffff", largeOrUI: false))
    }

    // MARK: light-mode palette audit (the regression guard)

    private let light = DashboardTheme.light

    /// Text tokens on the light background meet AA (4.5:1 body text) — including
    /// `textFaint`, the worst prior offender (#d0d0d0 = 1.54:1 → #6b6b6b = 5.33:1).
    func testLightTextTokensMeetAA() {
        let bg = light.bgPrimary
        for (name, fg) in [("textPrimary", light.textPrimary), ("textSecondary", light.textSecondary),
                           ("textFaint", light.textFaint)] {
            let r = Contrast.ratio(fg, bg) ?? 0
            XCTAssertGreaterThanOrEqual(r, Contrast.aaText, "\(name) (\(fg)) must meet 4.5:1 text — got \(r)")
        }
        // textTertiary is a UI/label token (4.48:1) — passes the 3:1 UI bar.
        XCTAssertTrue(Contrast.meetsAA(foreground: light.textTertiary, background: bg, largeOrUI: true))
    }

    /// The semantic STATUS accents (dots/chips/badges) meet AA on the light bg — most
    /// now clear 4.5:1 (used as chip text), all clear the 3:1 UI floor.
    func testLightStatusAccentsMeetAA() {
        let bg = light.bgPrimary
        let pairs: [(String, String)] = [
            ("statusActive", light.statusActive),   // green-700
            ("statusWorking", light.statusWorking),  // amber-700
            ("statusError", light.statusError),      // red-600
            ("statusUnread", light.statusUnread),    // cyan-700
            ("statusNeedsInput", light.statusNeedsInput), // purple-600
            ("statusEnded", light.statusEnded),      // #6b6b6b
        ]
        for (name, fg) in pairs {
            XCTAssertTrue(Contrast.meetsAA(foreground: fg, background: bg, largeOrUI: true),
                          "\(name) (\(fg)) must meet 3:1 UI on white — got \(Contrast.ratio(fg, bg) ?? 0)")
        }
    }

    /// The decorative accents used as fg (orange engagement badge, blue git link) meet
    /// AA on the light bg.
    func testLightDecorativeAccentsMeetAA() {
        let bg = light.bgPrimary
        for (name, fg) in [("accentOrange", light.accentOrange), ("accentBlue", light.accentBlue),
                           ("accentPurple", light.accentPurple)] {
            XCTAssertTrue(Contrast.meetsAA(foreground: fg, background: bg, largeOrUI: true),
                          "\(name) (\(fg)) must meet 3:1 UI — got \(Contrast.ratio(fg, bg) ?? 0)")
        }
    }

    // MARK: dark-mode regression guard (must NOT change)

    /// Cluster 3 is a LIGHT-only fix. Pin the dark palette accents so darkening light
    /// can never silently touch dark.
    func testDarkPaletteUnchanged() {
        let d = DashboardTheme.dark
        XCTAssertEqual(d.accentGreen, "#22c55e")
        XCTAssertEqual(d.accentYellow, "#eab308")
        XCTAssertEqual(d.accentRed, "#ef4444")
        XCTAssertEqual(d.accentCyan, "#06b6d4")
        XCTAssertEqual(d.accentOrange, "#f97316")
        XCTAssertEqual(d.accentPurple, "#a855f7")
        XCTAssertEqual(d.accentBlue, "#3b82f6")
        XCTAssertEqual(d.textFaint, "#3a3a3a")
        // Dark accents meet AA on the DARK bg (they're bright-on-dark) — unaffected.
        XCTAssertTrue(Contrast.meetsAA(foreground: d.accentGreen, background: d.bgPrimary, largeOrUI: true))
    }
}
