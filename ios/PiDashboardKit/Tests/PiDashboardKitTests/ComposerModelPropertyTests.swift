import XCTest
@testable import PiDashboardKit

/// PROPERTY coverage of the adaptive-composer hysteresis (the explicitly-named
/// North Star, F4) + the model/theme surfaces. The seed `ComposerLayoutTests`
/// pins representative points; this file SWEEPS the 20/45 boundary exhaustively to
/// prove the asymmetric rule has NO flip-flop pocket under any single-character
/// edit — the property the constants 20/20 exist to guarantee.
///
/// New file (no collision with the seed `ComposerLayoutTests`).
final class ComposerModelPropertyTests: XCTestCase {

    private let floor = ComposerLayout.columnLengthFloor   // 20
    private let wrap = ComposerLayout.wrapHeightThreshold  // 45

    // MARK: hysteresis boundary sweep

    /// Newline ⇒ multiline ALWAYS, for any previous state / length / height.
    func testNewlineForcesMultilineUniversally() {
        for prev in [false, true] {
            for len in [0, 1, 21, 100] {
                for h in [0.0, 30, 60, 999] {
                    let text = "a\n" + String(repeating: "x", count: max(0, len - 2))
                    XCTAssertTrue(ComposerLayout.isMultiline(previous: prev, text: text, contentHeight: h),
                                  "newline always multiline (prev=\(prev) len=\(len) h=\(h))")
                }
            }
        }
    }

    /// ENTRY rule (prev=false, no newline): multiline iff height>45 AND length>20.
    /// Swept across the whole boundary neighborhood.
    func testEntryRuleRequiresBothHeightAndLength() {
        for len in 0...45 {
            for h in stride(from: 0.0, through: 90, by: 5) {
                let text = String(repeating: "x", count: len)
                let expected = (h > wrap) && (len > floor)
                XCTAssertEqual(
                    ComposerLayout.isMultiline(previous: false, text: text, contentHeight: h), expected,
                    "entry rule at len=\(len) h=\(h)")
            }
        }
    }

    /// STAY rule (prev=true, no newline): multiline iff length>20 — height ignored.
    func testStayRuleIsLengthOnly() {
        for len in 0...45 {
            for h in [0.0, 46, 999] {
                let text = String(repeating: "x", count: len)
                XCTAssertEqual(
                    ComposerLayout.isMultiline(previous: true, text: text, contentHeight: h), len > floor,
                    "stay rule at len=\(len) h=\(h) is length-only")
            }
        }
    }

    /// THE no-flip-flop property: simulate typing up to 60 chars (with a wrapped
    /// height once long) then deleting back to empty, feeding the previous state
    /// back in each step. The state must be MONOTONE — it switches to multiline
    /// once and switches back once, never oscillating on a single-char edit.
    func testNoFlipFlopAcrossSingleCharEdits() {
        var prev = false
        var transitions = 0
        var lastFalseToTrueLen: Int?
        var lastTrueToFalseLen: Int?

        // type 0→60
        for len in 0...60 {
            let text = String(repeating: "x", count: len)
            // height grows past the wrap threshold once we're clearly long.
            let h = len > floor ? 60.0 : 30.0
            let next = ComposerLayout.isMultiline(previous: prev, text: text, contentHeight: h)
            if next != prev { transitions += 1; if next { lastFalseToTrueLen = len } }
            prev = next
        }
        // delete 60→0
        for len in stride(from: 60, through: 0, by: -1) {
            let text = String(repeating: "x", count: len)
            let h = len > floor ? 60.0 : 30.0
            let next = ComposerLayout.isMultiline(previous: prev, text: text, contentHeight: h)
            if next != prev { transitions += 1; if !next { lastTrueToFalseLen = len } }
            prev = next
        }

        XCTAssertEqual(transitions, 2, "exactly one enter + one exit across the full type/delete cycle")
        XCTAssertEqual(lastFalseToTrueLen, floor + 1, "enters multiline at length 21 (>20, wrapped)")
        XCTAssertEqual(lastTrueToFalseLen, floor, "reverts to single-row at length 20 (≤20)")
        XCTAssertFalse(prev, "ends single-row after deleting to empty")
    }

    /// The seam itself: at exactly the shared floor (20) you can't be multiline by
    /// length, and at 21 you stay multiline once entered — so 20↔21 never oscillates.
    func testSharedFloorHasNoOscillationPocket() {
        // at 21, wrapped, from single → enters.
        XCTAssertTrue(ComposerLayout.isMultiline(previous: false, text: String(repeating: "x", count: 21), contentHeight: 46))
        // at 21, from multiline → stays (height irrelevant).
        XCTAssertTrue(ComposerLayout.isMultiline(previous: true, text: String(repeating: "x", count: 21), contentHeight: 0))
        // at 20, from multiline → reverts.
        XCTAssertFalse(ComposerLayout.isMultiline(previous: true, text: String(repeating: "x", count: 20), contentHeight: 999))
        // at 20, from single → never enters.
        XCTAssertFalse(ComposerLayout.isMultiline(previous: false, text: String(repeating: "x", count: 20), contentHeight: 999))
    }

    // MARK: height clamp

    func testClampedHeightProperties() {
        // empty always resets to the single-line floor.
        XCTAssertEqual(ComposerLayout.clampedHeight(text: "", measured: -100), ComposerLayout.minHeight)
        XCTAssertEqual(ComposerLayout.clampedHeight(text: "", measured: 9999), ComposerLayout.minHeight)
        // non-empty stays within [min, max] for any measured input.
        for m in stride(from: -50.0, through: 400, by: 13) {
            let h = ComposerLayout.clampedHeight(text: "x", measured: m)
            XCTAssertGreaterThanOrEqual(h, ComposerLayout.minHeight)
            XCTAssertLessThanOrEqual(h, ComposerLayout.maxHeight)
        }
        // monotone non-decreasing in the measured value (within the band).
        XCTAssertLessThanOrEqual(
            ComposerLayout.clampedHeight(text: "x", measured: 50),
            ComposerLayout.clampedHeight(text: "x", measured: 150))
    }

    // MARK: canSend gate

    func testCanSendTruthTable() {
        // disabled ⇒ never sendable.
        for img in 0...2 {
            for t in ["", "  ", "hi"] {
                XCTAssertFalse(ComposerLayout.canSend(text: t, imageCount: img, disabled: true))
            }
        }
        // enabled ⇒ sendable iff trimmed-nonempty OR has image.
        XCTAssertFalse(ComposerLayout.canSend(text: "", imageCount: 0, disabled: false))
        XCTAssertFalse(ComposerLayout.canSend(text: "   \n\t", imageCount: 0, disabled: false))
        XCTAssertTrue(ComposerLayout.canSend(text: "x", imageCount: 0, disabled: false))
        XCTAssertTrue(ComposerLayout.canSend(text: "", imageCount: 1, disabled: false))
        XCTAssertTrue(ComposerLayout.canSend(text: "   ", imageCount: 2, disabled: false))
    }

    // MARK: model + theme surfaces

    func testModelInfoQualifiedForm() {
        XCTAssertEqual(ModelInfo(provider: "anthropic", id: "claude-opus-4").qualified, "anthropic/claude-opus-4")
        XCTAssertEqual(ModelInfo(provider: "github-copilot", id: "claude-opus-4.8").qualified, "github-copilot/claude-opus-4.8")
    }

    func testModelInfoDecodesAndIsIdentifiable() throws {
        let m = try JSONDecoder().decode(ModelInfo.self, from: Data(#"{"provider":"openai","id":"gpt-5"}"#.utf8))
        XCTAssertEqual(m.id, "gpt-5")
        XCTAssertEqual(m.qualified, "openai/gpt-5")
    }

    /// Session status → the ONE semantic card hue via `sessionAccent` (active→green,
    /// streaming→AMBER, ended→muted, unknown→muted). Migrated off the removed backwards
    /// `statusColor` (which mapped streaming→blue); the full precedence lives in
    /// `SessionColorTests`, this pins the corrected mapping at the old call site.
    func testSessionStatusHueMapping() {
        let p = DashboardTheme.dark
        func s(_ status: String?) -> DashboardSession { DashboardSession(id: "s", status: status) }
        XCTAssertEqual(DashboardTheme.sessionAccent(s("active"), p), p.statusActive)   // green
        XCTAssertEqual(DashboardTheme.sessionAccent(s("streaming"), p), p.statusWorking) // amber, NOT blue
        XCTAssertEqual(DashboardTheme.sessionAccent(s("ended"), p), p.statusEnded)     // muted
        XCTAssertEqual(DashboardTheme.sessionAccent(s("weird"), p), p.statusEnded)     // unknown → muted
        XCTAssertEqual(DashboardTheme.sessionAccent(s(nil), p), p.statusEnded)
    }

    /// The dark palette tokens are the operator's lifted hexes (DESIGN.md §5) —
    /// guards against an accidental token drift in the shared core.
    func testDarkPaletteCoreTokens() {
        let p = DashboardTheme.dark
        XCTAssertEqual(p.bgPrimary, "#0a0a0a")
        XCTAssertEqual(p.bgTertiary, "#1e1e1e")
        XCTAssertEqual(p.accentGreen, "#22c55e")
        XCTAssertEqual(p.accentBlue, "#3b82f6")
        XCTAssertEqual(p.accentRed, "#ef4444")
        XCTAssertEqual(p.accentPrimary, p.accentBlue, "accentPrimary aliases blue")
    }
}
